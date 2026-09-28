'use strict';
// source → a local file Deepgram can be pointed at. Three shapes (Ф0 contract §2.2):
//   1. existing local path — used as is;
//   2. http(s) URL — downloaded into os.tmpdir() and ALWAYS removed by cleanup();
//   3. a public Yandex.Disk link — resolved to a direct href, then treated as (2).
//
// Every failure is a typed {error, hint} (no stack traces): the model has to be able
// to rephrase the request, not debug an exception. The video guard runs on the raw
// source string BEFORE any network work, so a bad link fails fast and offline.

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { isVideoContainer, contentTypeFor, VIDEO_HINT } = require('./mime');

const DOWNLOAD_TIMEOUT_MS = 30000;
const RESOLVE_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

function typed(error, hint) {
  return { error, hint };
}

function isTyped(v) {
  return !!v && typeof v === 'object' && typeof v.error === 'string';
}

// Public Yandex.Disk link → direct download href (same endpoint core's
// video_analyze_batch already uses, so both paths resolve identically).
function resolveYandex(publicUrl) {
  return new Promise((resolve) => {
    const api = 'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=' +
      encodeURIComponent(publicUrl);
    https.get(api, { timeout: RESOLVE_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).href || ''); } catch { resolve(''); }
      });
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

function requestBuffer(urlStr, redirects = 0) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ error: typed('source_unavailable', `Некорректная ссылка: ${urlStr.slice(0, 120)}`) }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ error: typed('unsupported_source', 'Поддерживаются только локальные пути и http(s)-ссылки.') });
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'GET', timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(requestBuffer(next, redirects + 1));
      }
      if (status >= 400) {
        res.resume();
        return resolve({
          error: typed('source_unavailable',
            `Источник недоступен: HTTP ${status} ${res.statusMessage || ''}`.trim() + '.'),
        });
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '').split(';')[0].trim() }));
      res.on('error', () => resolve({ error: typed('source_unavailable', 'Соединение оборвано при скачивании источника.') }));
    });
    req.on('error', () => resolve({ error: typed('source_unavailable', 'Не удалось скачать источник (сеть/ДНС).') }));
    req.on('timeout', () => { req.destroy(); resolve({ error: typed('source_unavailable', `Источник не ответил за ${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} с.`) }); });
    req.end();
  });
}

function localFile(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return typed('source_unavailable', `Файл не найден: ${abs}`); }
  if (!st.isFile()) return typed('source_unavailable', `Это не файл: ${abs}`);
  if (st.size === 0) return typed('audio_empty', `Файл пуст: ${abs}`);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return typed('source_unavailable', `Не удалось прочитать файл: ${abs}`); }
  const contentType = contentTypeFor(abs, buf);
  if (!contentType) {
    return typed('unsupported_format',
      `Не удалось определить тип аудио по расширению/содержимому (${path.extname(abs) || 'без расширения'}). ` +
      'Поддерживаются ogg/mp3/wav/flac/m4a/aac и другие аудиоформаты.');
  }
  return { buffer: buf, contentType };
}

// → { buffer, contentType, cleanup } | { error, hint }
async function prepareSource(source) {
  const s = String(source || '').trim();
  if (!s) {
    return typed('unsupported_source',
      'Параметр source обязателен: локальный путь, http(s)-ссылка или публичная ссылка Яндекс.Диска.');
  }
  if (isVideoContainer(s)) return typed('unsupported_source', VIDEO_HINT);

  if (/yadi\.sk|disk\.yandex/i.test(s)) {
    const href = await resolveYandex(s);
    if (!href) return typed('source_unavailable', 'Не удалось разрешить публичную ссылку Яндекс.Диска в прямой файл.');
    return prepareSource(href);
  }

  if (/^https?:\/\//i.test(s)) {
    const got = await requestBuffer(s);
    if (isTyped(got)) return got.error;
    // The download MUST land on disk (scenario step 2) and be removed in finally.
    const tmp = path.join(os.tmpdir(), `speech-src-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.bin`);
    try {
      fs.writeFileSync(tmp, got.buffer);
    } catch {
      return typed('source_unavailable', 'Не удалось сохранить скачанный файл во временный каталог.');
    }
    if (isVideoContainer(new URL(s).pathname)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return typed('unsupported_source', VIDEO_HINT);
    }
    const contentType = contentTypeFor(new URL(s).pathname, got.buffer)
      || (got.contentType && got.contentType.startsWith('audio/') ? got.contentType : null);
    if (!contentType) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return typed('unsupported_format', `Сервер отдал тип «${got.contentType || 'без типа'}» — это не аудио, которое умеет распознавать speech_transcribe.`);
    }
    return {
      buffer: got.buffer,
      contentType,
      cleanup: () => { try { fs.unlinkSync(tmp); } catch { /* already gone */ } },
    };
  }

  const abs = path.resolve(s);
  const local = localFile(abs);
  if (isTyped(local)) return local;
  return { buffer: local.buffer, contentType: local.contentType, cleanup: null };
}

module.exports = { prepareSource, isTyped, requestBuffer, resolveYandex, localFile };
