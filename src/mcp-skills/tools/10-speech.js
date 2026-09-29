'use strict';

// Speech domain tools (Ф0). Single prefix `speech_` — tool names must never collide
// with another repo (mcp-action.js treats a duplicate as CONFLICT), which is why the
// legacy `video_set_deepgram_key` alias stays in trained-assist-agent's core.
//
// Contract: docs/user-scenarios/speech/01-speech-transcribe.md (core repo),
// design: docs/user-scenarios/speech/03-proposal-design.md §2.2–2.4.
//
// Typed errors are RETURNED as {error, hint} in the tool text, never thrown: a thrown
// error becomes a JSON-RPC error the model sees as a failure envelope instead of an
// answer it can act on.

const { writeKey, readKey, resolveKey, readCalls, appendCall } = require('../../deepgram/key-store');
const { prepareSource, isTyped } = require('../../audio/source');
const { isVideoContainer, VIDEO_HINT } = require('../../audio/mime');
const deepgram = require('../../deepgram/client');

const DEFAULT_LANGUAGE = 'ru';
const DEFAULT_MODEL = 'nova-2';

// Ф0 pins the engine. `model` stays in the schema so Ф2 can switch to Nova-3 without
// changing the contract, but a caller asking for another model gets an explicit typed
// error — never a silent no-op that would make them think it applied.
function featureDisabled(args) {
  if (args.diarize === true) {
    return {
      error: 'feature_disabled',
      hint: 'Диаризация (роли говорящих) — фаза Ф1, в Ф0 не активна. Убери diarize, чтобы распознать как есть.',
    };
  }
  const kw = args.keywords;
  if ((Array.isArray(kw) && kw.length > 0) || (typeof kw === 'string' && kw.trim())) {
    return {
      error: 'feature_disabled',
      hint: 'Словарь терминов (keywords/keyterm) — фаза Ф2, в Ф0 не активен. Убери keywords, чтобы распознать как есть.',
    };
  }
  if (args.model !== undefined && args.model !== null && String(args.model) !== DEFAULT_MODEL) {
    return {
      error: 'feature_disabled',
      hint: `В Ф0 движок закреплён на ${DEFAULT_MODEL}; смена модели — Ф2. Убери model или передай "${DEFAULT_MODEL}".`,
    };
  }
  return null;
}

function costHint(model, durationSec) {
  return {
    model,
    duration_sec: durationSec,
    note:
      'Цена модели на странице Deepgram не публикуется — точную стоимость бери из своего тарифа. ' +
      'Ориентир для сравнения: Nova-3 ≈ $0.258/час аудио.',
  };
}

function recordCall(entry) {
  appendCall({ at: new Date().toISOString(), ...entry });
}

async function transcribe(args = {}) {
  const disabled = featureDisabled(args);
  if (disabled) return disabled;

  const source = String(args.source || '').trim();
  if (!source) {
    return {
      error: 'unsupported_source',
      hint: 'Параметр source обязателен: локальный путь, http(s)-ссылка или публичная ссылка Яндекс.Диска.',
    };
  }
  if (isVideoContainer(source)) return { error: 'unsupported_source', hint: VIDEO_HINT };

  const key = readKey();
  if (!key) {
    return { error: 'key_missing', hint: 'Ключ Deepgram не задан — вызови speech_set_key(key) и повтори.' };
  }

  const language = String(args.language || DEFAULT_LANGUAGE) === 'auto' ? 'auto' : String(args.language || DEFAULT_LANGUAGE);
  const model = DEFAULT_MODEL;

  const prepared = await prepareSource(source);
  if (isTyped(prepared)) return prepared;
  try {
    const res = await deepgram.transcribe({
      key,
      buffer: prepared.buffer,
      contentType: prepared.contentType,
      language,
      model,
    });
    if (res.error) {
      recordCall({ ok: false, duration_sec: null, chars: 0, error: res.error });
      return res;
    }
    recordCall({ ok: true, duration_sec: res.duration, chars: res.text.length });
    return {
      text: res.text,
      duration: res.duration,
      language,
      cost_hint: costHint(model, res.duration),
    };
  } finally {
    // Scenario step 2: a downloaded temp file never survives the call, success or not.
    if (typeof prepared.cleanup === 'function') prepared.cleanup();
  }
}

module.exports = {
  // Always visible: without the key the user still has to be able to set it,
  // and a missing key must produce a typed error, never "Unknown tool".
  isReady: () => true,
  setupTools: ['speech_set_key', 'speech_status'],

  tools: {
    speech_transcribe: {
      description:
        'Распознать речь в аудио (голосовое/аудиофайл/запись звонка) в текст. Принимает локальный путь, ' +
        'http(s)-ссылку или публичную ссылку Яндекс.Диска. Возвращает {text, duration, language, cost_hint}. ' +
        'Только аудио: видео-контейнер отклоняется (video декодирует video_analyze_batch в ядре). ' +
        'Требует ключ Deepgram (speech_set_key).',
      inputSchema: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'Локальный путь к аудиофайлу, прямой http(s)-URL или публичная ссылка Яндекс.Диска. Видео-контейнеры (.mp4 .mkv .mov …) не поддерживаются.',
          },
          language: { type: 'string', description: 'Язык распознавания (ru/en/…) или "auto" для авто-определения. Дефолт ru.' },
          model: { type: 'string', description: 'Зарезервировано. Ф0 закреплён на nova-2; другое значение → типизированная ошибка feature_disabled.' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Зарезервировано под Ф2 (словарь терминов). В Ф0 непустой список → типизированная ошибка feature_disabled.',
          },
          diarize: { type: 'boolean', description: 'Зарезервировано под Ф1 (роли говорящих). В Ф0 diarize:true → типизированная ошибка feature_disabled.' },
        },
        required: ['source'],
      },
      handler: transcribe,
    },

    speech_set_key: {
      description:
        'Сохранить API-ключ Deepgram для распознавания речи (нужен для speech_transcribe). ' +
        'Задаётся один раз, переживает сессии. Ключ хранится только на сервере (файл 0o600 в директории юзера), ' +
        'не в коде и не в ответах.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Deepgram API key (токен).' } },
        required: ['key'],
      },
      handler: async ({ key } = {}) => {
        if (!key || !String(key).trim()) {
          return { error: 'key_missing', hint: 'Передай key — непустую строку.' };
        }
        const path = writeKey(String(key));
        return { saved: true, path, hint: 'Ключ сохранён. speech_transcribe готов расшифровывать.' };
      },
    },

    speech_status: {
      description:
        'Состояние сервиса распознавания речи: есть ли ключ Deepgram и журнал последних вызовов ' +
        '(только метаданные: время/длительность/длина текста/ошибка — без самого текста). ' +
        'Вызывай, когда нужно проверить, готов ли speech_transcribe к работе.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { key, source } = resolveKey();
        const key_present = !!key;
        return {
          key_present,
          // profile = own key, platform = the host's shared key, env = one-shot override.
          key_source: source,
          last_calls: readCalls(),
          ...(key_present ? {} : { hint: 'Ключ Deepgram не задан — вызови speech_set_key(key).' }),
        };
      },
    },
  },
};
