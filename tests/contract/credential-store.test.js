'use strict';
// trained-assist-agent#1939 (C4 rollout шаг 1): the Deepgram key file
// (agent-tokens/<USER_ID>/deepgram/key.txt) is read and written through
// credential-store, not raw fs.
//
// Contract (epic #1789 P0 C4, #1819):
//   - legacy plaintext files pass through transparently;
//   - an encrypted (v2 base64 envelope) file is decrypted;
//   - a base64 stub is NEVER returned as the key value;
//   - a missing CRED_ENCRYPTION_KEY degrades to plaintext WITH a warning —
//     never a hard failure.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../../src/credential-store');
const { resolveKey, writeKey, keyPath } = require('../../src/deepgram/key-store');

const MASTER_KEY = 'a'.repeat(64); // valid 64-hex → 32-byte AES-256 key

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-cred-'));
  const saved = {
    tokens: process.env.AGENT_TOKENS_DIR,
    key: process.env.CRED_ENCRYPTION_KEY,
    dg: process.env.DEEPGRAM_KEY,
    platform: process.env.DEEPGRAM_API_KEY,
  };
  process.env.AGENT_TOKENS_DIR = root;
  delete process.env.CRED_ENCRYPTION_KEY;
  delete process.env.DEEPGRAM_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  store._resetMasterKey();
  t.after(() => {
    for (const [k, v] of Object.entries({ AGENT_TOKENS_DIR: saved.tokens, CRED_ENCRYPTION_KEY: saved.key, DEEPGRAM_KEY: saved.dg, DEEPGRAM_API_KEY: saved.platform })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    store._resetMasterKey();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'user-a', 'deepgram', 'key.txt') };
}

function captureWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try { return { result: fn(), warnings }; }
  finally { console.warn = original; }
}

test('legacy plaintext key file reads through unchanged (no CRED_ENCRYPTION_KEY)', (t) => {
  const h = sandbox(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, 'dg-legacy-key', 'utf8');

  assert.equal(store.readCredentialFile(h.file), 'dg-legacy-key');
  assert.deepEqual(resolveKey('user-a'), { key: 'dg-legacy-key', source: 'profile' });
});

test('missing CRED_ENCRYPTION_KEY → plaintext write with a warning, never a failure', (t) => {
  const h = sandbox(t);
  const { result, warnings } = captureWarn(() => writeKey('dg-plain-2', 'user-a'));

  assert.equal(result, h.file, 'writeKey returns the path');
  assert.equal(fs.readFileSync(h.file, 'utf8'), 'dg-plain-2', 'stored plaintext when no key is set');
  assert.ok(warnings.some(w => /PLAINTEXT/.test(w)), `expected a plaintext warning, got: ${warnings.join(' | ')}`);
  assert.deepEqual(resolveKey('user-a'), { key: 'dg-plain-2', source: 'profile' });
});

test('double read: with a key the file is encrypted at rest and still reads back', (t) => {
  const h = sandbox(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();

  captureWarn(() => writeKey('dg-encrypted-3', 'user-a'));

  const raw = fs.readFileSync(h.file, 'utf8');
  assert.notEqual(raw, 'dg-encrypted-3', 'at rest the file must not hold the plaintext key');
  assert.ok(store.isEncrypted(raw), 'at rest the file must be a v2 envelope');
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600, 'credential file must stay 0o600');

  // the same read through the store (and through the reader the skill uses)
  assert.equal(store.readCredentialFile(h.file), 'dg-encrypted-3');
  assert.deepEqual(resolveKey('user-a'), { key: 'dg-encrypted-3', source: 'profile' });
});

test('legacy plaintext still reads through once a key IS set', (t) => {
  const h = sandbox(t);
  fs.mkdirSync(path.dirname(h.file), { recursive: true });
  fs.writeFileSync(h.file, 'dg-still-legacy', 'utf8');

  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();

  assert.equal(store.readCredentialFile(h.file), 'dg-still-legacy');
  assert.deepEqual(resolveKey('user-a'), { key: 'dg-still-legacy', source: 'profile' });
});

test('a base64 stub is never returned as the key value', (t) => {
  const h = sandbox(t);
  process.env.CRED_ENCRYPTION_KEY = MASTER_KEY;
  store._resetMasterKey();
  captureWarn(() => writeKey('dg-secret-4', 'user-a'));

  const blob = fs.readFileSync(h.file, 'utf8');
  assert.ok(store.isEncrypted(blob), 'precondition: the file on disk is a base64 stub');

  // Key withdrawn (deploy without CRED_ENCRYPTION_KEY): the stub must not be
  // handed to the caller as if it were the Deepgram key.
  delete process.env.CRED_ENCRYPTION_KEY;
  store._resetMasterKey();

  assert.throws(() => store.readCredentialFile(h.file),
    /CRED_ENCRYPTION_KEY/, 'store-level: loud, no base64 garbage');
  const resolved = resolveKey('user-a');
  assert.notEqual(resolved.key, blob, 'the base64 stub must not be returned as the key');
  assert.equal(resolved.key, '', 'with the key withdrawn the profile file yields no key');
  assert.equal(resolved.source, null);
});

test('a missing key file is not an error (falls through to the platform key)', (t) => {
  sandbox(t);
  process.env.DEEPGRAM_API_KEY = 'platform-key';
  assert.deepEqual(resolveKey('user-a'), { key: 'platform-key', source: 'platform' });
  assert.ok(!fs.existsSync(path.join(process.env.AGENT_TOKENS_DIR, 'user-a', 'deepgram', 'key.txt')),
    'reading must not create a key file');
});
