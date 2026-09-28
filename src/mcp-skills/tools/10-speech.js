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

const { writeKey, readKey, readCalls } = require('../../deepgram/key-store');

module.exports = {
  // Always visible: without the key the user still has to be able to set it,
  // and a missing key must produce a typed error, never "Unknown tool".
  isReady: () => true,
  setupTools: ['speech_set_key', 'speech_status'],

  tools: {
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
        const key_present = !!readKey();
        return {
          key_present,
          last_calls: readCalls(),
          ...(key_present ? {} : { hint: 'Ключ Deepgram не задан — вызови speech_set_key(key).' }),
        };
      },
    },
  },
};
