'use strict';
// S2: speech_set_key / speech_status — the key lives at the SAME path the core used
// (no migration), mode 0o600, isolated per USER_ID, and status never throws.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMcp } = require('../helpers/mcp');

function env(userId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-keys-'));
  return {
    root,
    env: { AGENT_TOKENS_DIR: root, USER_ID: userId, HOME: root },
    keyFile: () => path.join(root, userId, 'deepgram', 'key.txt'),
    callsFile: () => path.join(root, userId, 'deepgram', 'calls.json'),
  };
}

test('speech_set_key writes 0o600 at agent-tokens/<USER_ID>/deepgram/key.txt', async () => {
  const h = env('user-a');
  const server = await startMcp({ env: h.env });
  try {
    const res = await server.tool('speech_set_key', { key: '  dg-secret-1  ' });
    assert.equal(res.isError, false, res.text);
    assert.equal(res.parsed.saved, true);

    const p = h.keyFile();
    assert.ok(fs.existsSync(p), `no key file at ${p}`);
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'key file must be 0o600');
    assert.equal(fs.statSync(p).size > 0, true, 'key file must not be empty');
    assert.equal(fs.readFileSync(p, 'utf8'), 'dg-secret-1');
    assert.strictEqual(res.parsed.path, p);

    const st = await server.tool('speech_status', {});
    assert.equal(st.parsed.key_present, true);
    assert.deepStrictEqual(st.parsed.last_calls, []);
  } finally {
    server.stop();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('speech_status without a key → {key_present:false, last_calls:[]} and no exception', async () => {
  const h = env('user-b');
  const server = await startMcp({ env: h.env });
  try {
    const st = await server.tool('speech_status', {});
    assert.equal(st.isError, false, st.text);
    assert.equal(st.parsed.key_present, false);
    assert.deepStrictEqual(st.parsed.last_calls, []);
    assert.match(st.parsed.hint || '', /speech_set_key/);
  } finally {
    server.stop();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('a different USER_ID cannot see another user\'s key', async () => {
  const h = env('user-a');
  const serverA = await startMcp({ env: h.env });
  const serverB = await startMcp({ env: { ...h.env, USER_ID: 'user-b' } });
  try {
    await serverA.tool('speech_set_key', { key: 'dg-for-a' });
    const seenB = await serverB.tool('speech_status', {});
    assert.equal(seenB.parsed.key_present, false, 'user-b must not see user-a key');
    const seenA = await serverA.tool('speech_status', {});
    assert.equal(seenA.parsed.key_present, true, 'user-a must still see its own key');
    assert.ok(!fs.existsSync(path.join(h.root, 'user-b', 'deepgram', 'key.txt')),
      'status must not create a key file for a user who has none');
  } finally {
    serverA.stop();
    serverB.stop();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('empty key → typed error, nothing written', async () => {
  const h = env('user-c');
  const server = await startMcp({ env: h.env });
  try {
    const res = await server.tool('speech_set_key', { key: '   ' });
    assert.equal(res.parsed && res.parsed.error, 'key_missing', res.text);
    assert.ok(!fs.existsSync(h.keyFile()), 'a rejected key must not touch the file');
  } finally {
    server.stop();
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('calls.json ring keeps metadata only, capped at 50, atomic file', async (t) => {
  const h = env('user-d');
  // key-store resolves tokensRoot() from the CURRENT process env — point it at the
  // sandbox root so the journal can never land in a real profile.
  const saved = process.env.AGENT_TOKENS_DIR;
  process.env.AGENT_TOKENS_DIR = h.root;
  t.after(() => {
    if (saved === undefined) delete process.env.AGENT_TOKENS_DIR;
    else process.env.AGENT_TOKENS_DIR = saved;
    fs.rmSync(h.root, { recursive: true, force: true });
  });
  try {
    // appendCall is the module the transcription path uses; drive it directly so this
    // test does not need a Deepgram stub (that is the transcribe suite's job).
    const { appendCall, readCalls, CALLS_MAX } = require('../../src/deepgram/key-store');
    for (let i = 0; i < 55; i++) {
      appendCall({ at: `t${i}`, ok: true, duration_sec: 1.5, chars: 40 }, 'user-d');
    }
    const calls = readCalls('user-d');
    assert.equal(calls.length, CALLS_MAX);
    assert.equal(calls[calls.length - 1].at, 't54');
    assert.ok(!fs.existsSync(h.callsFile() + '.tmp'), 'temp file must not survive the rename');
    const raw = fs.readFileSync(h.callsFile(), 'utf8');
    assert.ok(!/transcript|"text"/.test(raw), 'journal must not store the transcript text');
    assert.deepStrictEqual(Object.keys(calls[0]).sort(), ['at', 'chars', 'duration_sec', 'ok']);
  } finally {
    // env + sandbox cleanup handled by t.after above
  }
});
