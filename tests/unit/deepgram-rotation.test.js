'use strict';
// Deepgram key rotation: several profile keys, quota-aware selection, and the
// fallback chain. Pure units against a temp tokens root — no network, no real key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deepgram-rotation-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

// Point the skill at the temp root before requiring anything that resolves paths.
process.env.AGENT_TOKENS_DIR = TMP;
const { tokensRoot } = require('../../src/data-paths');
const {
  readProfileKeys, writeKeys, pickKeyByLimit, recordLimit, readLimits, resolveKeys, resolveKey,
} = require('../../src/deepgram/key-store');

const USER = 'rotation-test-user';
const KEY_DIR = path.join(tokensRoot(), USER, 'deepgram');

function writeKeyFile(content) {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(path.join(KEY_DIR, 'key.txt'), content, 'utf8');
}

test('readProfileKeys: legacy single key string → [one], JSON array → all', () => {
  writeKeyFile('legacy-single-key');
  assert.deepStrictEqual(readProfileKeys(USER), ['legacy-single-key']);

  writeKeyFile(JSON.stringify(['k-a', 'k-b', 'k-c']));
  assert.deepStrictEqual(readProfileKeys(USER), ['k-a', 'k-b', 'k-c']);

  writeKeyFile('   spaced-key   ');
  assert.deepStrictEqual(readProfileKeys(USER), ['spaced-key   '.trim()]);

  fs.rmSync(KEY_DIR, { recursive: true, force: true });
  assert.deepStrictEqual(readProfileKeys(USER), []);
});

test('writeKeys: string keeps legacy form, array stores a JSON array', () => {
  writeKeys('single', USER);
  assert.deepStrictEqual(readProfileKeys(USER), ['single']);

  writeKeys(['k1', 'k2'], USER);
  const raw = fs.readFileSync(path.join(KEY_DIR, 'key.txt'), 'utf8');
  assert.deepStrictEqual(JSON.parse(raw), ['k1', 'k2']);
  // 0600 — a permissive umask must not loosen a credential file.
  assert.strictEqual(fs.statSync(path.join(KEY_DIR, 'key.txt')).mode & 0o777, 0o600);

  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});

test('pickKeyByLimit: the key with the most quota wins; exhausted keys sink', () => {
  const keys = ['k-hungry', 'k-full', 'k-gone'];
  const now = Math.floor(Date.now() / 1000);
  recordLimit('k-hungry', { remaining: 5, resetAt: now + 3600 }, USER);
  recordLimit('k-full', { remaining: 900, resetAt: now + 3600 }, USER);
  recordLimit('k-gone', { remaining: 0, resetAt: now + 3600 }, USER); // drained, not yet reset

  assert.strictEqual(pickKeyByLimit(keys, USER), 'k-full');

  // Zero remaining but the reset already passed → eligible again.
  recordLimit('k-gone', { remaining: 0, resetAt: now - 10 }, USER);
  assert.strictEqual(pickKeyByLimit(['k-gone', 'k-hungry'], USER), 'k-gone');

  // Single key → chosen regardless of journal.
  assert.strictEqual(pickKeyByLimit(['k-hungry'], USER), 'k-hungry');

  // Unknown key in the set → treated as full quota.
  assert.strictEqual(pickKeyByLimit(['never-journaled'], USER), 'never-journaled');

  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});

test('pickKeyByLimit: every key drained, no reset yet → falls back to the first', () => {
  const keys = ['x1', 'x2'];
  const now = Math.floor(Date.now() / 1000);
  recordLimit('x1', { remaining: 0, resetAt: now + 3600 }, USER);
  recordLimit('x2', { remaining: 0, resetAt: now + 3600 }, USER);
  assert.strictEqual(pickKeyByLimit(keys, USER), 'x1');
  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});

test('resolveKeys: profile ranks by quota, exhausted keys last', () => {
  writeKeys(['k-a', 'k-b', 'k-c'], USER);
  const now = Math.floor(Date.now() / 1000);
  recordLimit('k-a', { remaining: 10, resetAt: now + 3600 }, USER);
  recordLimit('k-b', { remaining: 500, resetAt: now + 3600 }, USER);
  recordLimit('k-c', { remaining: 0, resetAt: now + 3600 }, USER);

  const { keys, source } = resolveKeys(USER);
  assert.strictEqual(source, 'profile');
  assert.deepStrictEqual(keys, ['k-b', 'k-a', 'k-c']);
  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});

test('resolveKey: single key from profile, canonical platform fallback', () => {
  writeKeys('only-profile-key', USER);
  const { key, source } = resolveKey(USER);
  assert.strictEqual(key, 'only-profile-key');
  assert.strictEqual(source, 'profile');
  fs.rmSync(KEY_DIR, { recursive: true, force: true });

  delete process.env.DEEPGRAM_KEY;
  process.env.SYSTEM_DEEPGRAM_API_KEY = 'platform-canonical';
  process.env.DEEPGRAM_API_KEY = 'platform-legacy';
  const r = resolveKey(USER);
  assert.strictEqual(r.key, 'platform-canonical'); // canonical wins over legacy
  assert.strictEqual(r.source, 'platform');
  delete process.env.SYSTEM_DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
});

test('resolveKeys: DEEPGRAM_KEY one-shot override wins over profile', () => {
  writeKeys(['profile-a', 'profile-b'], USER);
  process.env.DEEPGRAM_KEY = 'one-shot';
  const { keys, source } = resolveKeys(USER);
  assert.deepStrictEqual(keys, ['one-shot']);
  assert.strictEqual(source, 'env');
  delete process.env.DEEPGRAM_KEY;
  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});

test('readLimits: missing or malformed journal → {} (never throws)', () => {
  assert.deepStrictEqual(readLimits(USER), {});
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(path.join(KEY_DIR, 'keys.json'), 'not json', 'utf8');
  assert.deepStrictEqual(readLimits(USER), {});
  fs.writeFileSync(path.join(KEY_DIR, 'keys.json'), '[]', 'utf8');
  assert.deepStrictEqual(readLimits(USER), {});
  fs.rmSync(KEY_DIR, { recursive: true, force: true });
});
