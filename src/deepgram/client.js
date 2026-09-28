'use strict';
// The ONE Deepgram pre-recorded client for the whole platform (Ф0: 6 copies in core
// collapse into one call). Behaviour is deliberately identical to the core engine it
// replaces, so recognition does not degrade (T10):
//
//   POST /v1/listen?model=nova-2&smart_format=true&punctuate=true&paragraphs=true&language=ru
//   Authorization: Token <key> · Content-Type: <mime> · Content-Length
//   text     = results.channels[0].alternatives[0].paragraphs.transcript || …transcript
//   duration = metadata.duration (seconds | null)
//   timeout  = 300 s per attempt · 1 retry on network error / timeout / 5xx (pause 1 s)
//
// The endpoint origin is overridable with DEEPGRAM_API_HOST (full origin, DEFAULT
// https://api.deepgram.com). Tests use it to point at a loopback stub — no network,
// no key. It is a service-env switch only; it never reaches the model.
//
// Typed errors are RETURNED, never thrown: {error, hint}.

const http = require('http');
const https = require('https');

const DEFAULT_API_HOST = 'https://api.deepgram.com';
const ATTEMPT_TIMEOUT_MS = 300000;
const RETRY_PAUSE_MS = 1000;
const MAX_ATTEMPTS = 2;

function apiBase() {
  const raw = String(process.env.DEEPGRAM_API_HOST || '').trim() || DEFAULT_API_HOST;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return new URL(DEFAULT_API_HOST);
    return u;
  } catch {
    return new URL(DEFAULT_API_HOST);
  }
}

function buildQuery({ model, language }) {
  const qs = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    paragraphs: 'true',
  });
  if (language && language !== 'auto') qs.set('language', language);
  else qs.set('detect_language', 'true');
  return qs;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One HTTP attempt. Resolves to {status, body, contentType} or {retryable, reason}.
function attempt(base, query, key, contentType, buffer) {
  return new Promise((resolve) => {
    const lib = base.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: `/v1/listen?${query.toString()}`,
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': contentType,
        'Content-Length': buffer.length,
      },
      timeout: ATTEMPT_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 500) return resolve({ retryable: true, reason: `Deepgram HTTP ${status}` });
        resolve({ status, body: data });
      });
      res.on('error', () => resolve({ retryable: true, reason: 'Deepgram: соединение оборвано' }));
    });
    req.on('error', (e) => resolve({ retryable: true, reason: `Deepgram: сеть недоступна (${e.code || e.message})` }));
    req.on('timeout', () => { req.destroy(); resolve({ retryable: true, reason: 'Deepgram: таймаут' }); });
    req.write(buffer);
    req.end();
  });
}

// Shape the response exactly as the core engine did.
function parseResponse(body) {
  let d;
  try { d = JSON.parse(body); } catch { return { error: 'upstream_error', hint: `Deepgram вернул не-JSON: ${String(body).slice(0, 200)}` }; }
  const alt = d?.results?.channels?.[0]?.alternatives?.[0];
  const text = String(alt?.paragraphs?.transcript || alt?.transcript || '').trim();
  if (!text) {
    return { error: 'audio_empty', hint: 'Deepgram вернул пустой текст (тишина или речь не распознана) — запись не кэшируется, повтор перепробует.' };
  }
  const duration = typeof d?.metadata?.duration === 'number' ? d.metadata.duration : null;
  return { text, duration };
}

// → { text, duration } | { error, hint }
async function transcribe({ key, buffer, contentType, language = 'ru', model = 'nova-2' }) {
  const base = apiBase();
  const query = buildQuery({ model, language });
  let lastReason = 'Deepgram недоступен';
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const res = await attempt(base, query, key, contentType, buffer);
    if (res.retryable) {
      lastReason = res.reason;
      if (i < MAX_ATTEMPTS - 1) { await pause(RETRY_PAUSE_MS); continue; }
      break;
    }
    if (res.status === 200) return parseResponse(res.body);
    if (res.status === 401 || res.status === 403) {
      return { error: 'upstream_error', hint: 'Deepgram отклонил ключ (401/403). Проверь ключ и вызови speech_set_key снова.' };
    }
    if (res.status >= 400) {
      return { error: 'upstream_error', hint: `Deepgram HTTP ${res.status}: ${String(res.body).slice(0, 200)}` };
    }
    return { error: 'upstream_error', hint: `Неожиданный ответ Deepgram: HTTP ${res.status}` };
  }
  return { error: 'upstream_error', hint: `${lastReason} — после ${MAX_ATTEMPTS} попыток.` };
}

module.exports = { transcribe, apiBase, buildQuery, parseResponse, ATTEMPT_TIMEOUT_MS, MAX_ATTEMPTS };
