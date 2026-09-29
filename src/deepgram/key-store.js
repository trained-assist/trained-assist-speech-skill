'use strict';
// Durable Deepgram credentials + call metadata for ONE user (per-user isolation, T13).
//
// The key file path is deliberately identical to what trained-assist-agent's core used
// (`~/agent-tokens/<USER_ID>/deepgram/key.txt`) so Ф0 needs no migration: existing
// keys keep working, and video_set_deepgram_key / speech_set_key write the same file.
// PII: calls.json records metadata only (at/ok/duration/chars/error) — never the text.

const fs = require('fs');
const path = require('path');
const { tokensRoot } = require('../data-paths');

const CALLS_MAX = 50;

function userIdOrDefault(userId) {
  if (userId !== undefined && userId !== null && String(userId) !== '') return String(userId);
  return String(process.env.USER_ID || '');
}

function keyDir(userId) {
  return path.join(tokensRoot(), userIdOrDefault(userId), 'deepgram');
}

function keyPath(userId) {
  return path.join(keyDir(userId), 'key.txt');
}

function callsPath(userId) {
  return path.join(keyDir(userId), 'calls.json');
}

// Resolution order (first non-empty wins):
//   1. DEEPGRAM_KEY — documented one-shot override (smoke runs); never lands on disk.
//   2. the profile's own key file — a user who set a key pays for their own usage.
//   3. DEEPGRAM_API_KEY — the platform key the host injects into MCP servers (the same
//      key intake uses for voice messages). Without this fallback the platform advertised
//      «транскрибация доступна» while speech_transcribe answered key_missing to every
//      profile that never set a personal key (2026-09-29).
function resolveKey(userId) {
  const fromEnv = process.env.DEEPGRAM_KEY;
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  try {
    const own = fs.readFileSync(keyPath(userId), 'utf8').trim();
    if (own) return { key: own, source: 'profile' };
  } catch {
    // no personal key — fall through to the platform key
  }
  const platform = process.env.DEEPGRAM_API_KEY;
  if (platform && platform.trim()) return { key: platform.trim(), source: 'platform' };
  return { key: '', source: null };
}

function readKey(userId) {
  return resolveKey(userId).key;
}

function writeKey(key, userId) {
  const p = keyPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(key).trim(), { encoding: 'utf8', mode: 0o600 });
  // A permissive umask must not loosen a credential file.
  fs.chmodSync(p, 0o600);
  return p;
}

function readCalls(userId) {
  try {
    const v = JSON.parse(fs.readFileSync(callsPath(userId), 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Ring buffer, atomic replace — a half-written journal must never be readable.
function appendCall(entry, userId) {
  try {
    const dir = keyDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const list = readCalls(userId);
    list.push(entry);
    while (list.length > CALLS_MAX) list.shift();
    const p = callsPath(userId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    // Journaling is telemetry: it must never fail the transcription itself.
    return false;
  }
}

module.exports = { keyPath, keyDir, readKey, resolveKey, writeKey, readCalls, appendCall, callsPath, CALLS_MAX };
