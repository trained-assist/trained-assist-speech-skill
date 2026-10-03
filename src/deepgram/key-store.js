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
const { readCredentialFile, writeCredentialFile } = require('../credential-store');

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

function keysPath(userId) {
  return path.join(keyDir(userId), 'keys.json');
}

function callsPath(userId) {
  return path.join(keyDir(userId), 'calls.json');
}

// ── Multi-key rotation ────────────────────────────────────────────────────────
// key.txt may hold either a single key (legacy plaintext) or a JSON array of
// keys. When it holds an array the caller rotates across them, picking the key
// whose Deepgram quota is furthest from exhausted.
//
// keys.json is the quota journal, written by recordLimit() after every call:
//   { "<key>": { "remaining": <n>, "reset_at": <unix-seconds>, "updated": <iso> } }
// It is telemetry, never a secret — the keys themselves live in key.txt.

function limitsPath(userId) {
  return path.join(keyDir(userId), 'keys.json');
}

function readLimits(userId) {
  try {
    const v = JSON.parse(fs.readFileSync(limitsPath(userId), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeLimits(limits, userId) {
  try {
    const dir = keyDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    const p = limitsPath(userId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(limits, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

// Merge a quota report from a response into the journal. Best-effort.
function recordLimit(key, { remaining = null, resetAt = null }, userId) {
  if (!key) return false;
  const uid = userIdOrDefault(userId);
  const limits = readLimits(uid);
  const prev = limits[key] || {};
  limits[key] = {
    remaining: remaining != null ? remaining : prev.remaining ?? null,
    reset_at: resetAt != null ? resetAt : prev.reset_at ?? null,
    updated: new Date().toISOString(),
  };
  return writeLimits(limits, uid);
}

// → the key with the most quota left, or null when every key is exhausted.
// A key with no journal entry is treated as fully available (never probed).
function pickKeyByLimit(keys, userId) {
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];
  const limits = readLimits(userId);
  const now = Math.floor(Date.now() / 1000);
  const available = [];
  for (const k of keys) {
    const rec = limits[k];
    if (rec && rec.remaining === 0 && rec.reset_at && rec.reset_at > now) continue; // exhausted — not yet
    available.push(k);
  }
  if (!available.length) return keys[0]; // all exhausted → try the first anyway
  let best = available[0];
  let bestRemaining = -1;
  for (const k of available) {
    const rec = limits[k];
    // A drained key whose reset already passed is treated as full again.
    const drained = rec && rec.remaining === 0 && rec.reset_at && rec.reset_at <= now;
    const remaining = drained
      ? Number.MAX_SAFE_INTEGER
      : (rec && rec.remaining != null ? rec.remaining : Number.MAX_SAFE_INTEGER);
    if (remaining > bestRemaining) { bestRemaining = remaining; best = k; }
  }
  return best;
}

// → string[] of profile keys: the JSON array form of key.txt, or [legacy string].
function readProfileKeys(userId) {
  try {
    const raw = readCredentialFile(keyPath(userId)).trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* not JSON — legacy single key */ }
    return [raw];
  } catch {
    return [];
  }
}

// Resolution order (first non-empty wins):
//   1. DEEPGRAM_KEY — documented one-shot override (smoke runs); never lands on disk.
//   2. the profile's own key file — a user who set a key pays for their own usage.
//      With several keys the one with the most quota left is picked.
//   3. DEEPGRAM_API_KEY / SYSTEM_DEEPGRAM_API_KEY — the platform key the host injects
//      into MCP servers (the same key intake uses for voice messages). Without this
//      fallback the platform advertised «транскрибация доступна» while speech_transcribe
//      answered key_missing to every profile that never set a personal key (2026-09-29).
function resolveKey(userId) {
  const fromEnv = process.env.DEEPGRAM_KEY;
  if (fromEnv && fromEnv.trim()) return { key: fromEnv.trim(), source: 'env' };
  const profileKeys = readProfileKeys(userId);
  if (profileKeys.length) {
    const picked = pickKeyByLimit(profileKeys, userId);
    return { key: picked, source: 'profile' };
  }
  const platform = process.env.SYSTEM_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY;
  if (platform && platform.trim()) return { key: platform.trim(), source: 'platform' };
  return { key: '', source: null };
}

// → { keys: string[], source } — every key the profile has, best-quota first.
// Callers that rotate use this; callers that need one key use resolveKey().
function resolveKeys(userId) {
  const fromEnv = process.env.DEEPGRAM_KEY;
  if (fromEnv && fromEnv.trim()) return { keys: [fromEnv.trim()], source: 'env' };
  const profileKeys = readProfileKeys(userId);
  if (profileKeys.length) {
    const limits = readLimits(userId);
    const now = Math.floor(Date.now() / 1000);
    const ranked = [...profileKeys].sort((a, b) => {
      const ra = limits[a] && limits[a].remaining != null ? limits[a].remaining : Number.MAX_SAFE_INTEGER;
      const rb = limits[b] && limits[b].remaining != null ? limits[b].remaining : Number.MAX_SAFE_INTEGER;
      // Exhausted keys sink to the bottom.
      const ea = limits[a] && limits[a].remaining === 0 && limits[a].reset_at && limits[a].reset_at > now;
      const eb = limits[b] && limits[b].remaining === 0 && limits[b].reset_at && limits[b].reset_at > now;
      if (ea !== eb) return ea ? 1 : -1;
      return rb - ra;
    });
    return { keys: ranked, source: 'profile' };
  }
  const platform = process.env.SYSTEM_DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY;
  if (platform && platform.trim()) return { keys: [platform.trim()], source: 'platform' };
  return { keys: [], source: null };
}

function readKey(userId) {
  return resolveKey(userId).key;
}

// Replace the profile's key set. Accepts a string (single key) or an array.
// Writing an array is what enables rotation; writing a string keeps legacy.
function writeKeys(keys, userId) {
  const p = keyPath(userId);
  const value = Array.isArray(keys) ? JSON.stringify(keys.map(String)) : String(keys).trim();
  writeCredentialFile(p, value);
  fs.chmodSync(p, 0o600);
  return p;
}

function writeKey(key, userId) {
  return writeKeys(key, userId);
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

module.exports = {
  keyPath, keyDir, keysPath, limitsPath,
  readKey, resolveKey, resolveKeys, readProfileKeys, pickKeyByLimit,
  writeKey, writeKeys, recordLimit, readLimits,
  readCalls, appendCall, callsPath, CALLS_MAX,
};
