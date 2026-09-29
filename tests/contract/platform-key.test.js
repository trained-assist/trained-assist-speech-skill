'use strict';
// The host injects its shared Deepgram key into every MCP server as DEEPGRAM_API_KEY
// (the same key intake uses for voice messages). A profile without a personal key must
// transcribe with it; a personal key, when set, still wins (2026-09-29: every profile
// without key.txt got key_missing while the platform advertised transcription).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMcp } = require('../helpers/mcp');
const { startStub, OGG_BYTES } = require('../helpers/stub-deepgram');

async function harness(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-pk-'));
  const tokens = path.join(root, 'tokens');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tokens, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const stub = await startStub();
  const server = await startMcp({
    env: { AGENT_TOKENS_DIR: tokens, USER_ID: 'pk-user', TMPDIR: tmp, HOME: root, DEEPGRAM_API_HOST: stub.host, ...extraEnv },
  });
  t.after(() => { server.stop(); stub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const audio = path.join(root, 'a.ogg');
  fs.writeFileSync(audio, OGG_BYTES);
  return { server, stub, audio, keyFile: path.join(tokens, 'pk-user', 'deepgram', 'key.txt') };
}

test('no personal key + platform DEEPGRAM_API_KEY → status present (source=platform), transcribe uses it', async (t) => {
  const h = await harness(t, { DEEPGRAM_API_KEY: 'dg-platform' });
  const st = await h.server.tool('speech_status', {});
  assert.equal(st.parsed.key_present, true, st.text);
  assert.equal(st.parsed.key_source, 'platform');
  assert.ok(!st.parsed.hint, 'no «set a key» hint when the platform key works');

  const res = await h.server.tool('speech_transcribe', { source: h.audio });
  assert.equal(res.isError, false, res.text);
  assert.ok(!res.parsed.error, res.text);
  const listen = h.stub.requests.find(x => x.url.includes('/v1/listen'));
  assert.equal(listen.authorization, 'Token dg-platform');
  assert.ok(!fs.existsSync(h.keyFile), 'the platform key must never be written into a profile');
});

test('personal key wins over the platform key', async (t) => {
  const h = await harness(t, { DEEPGRAM_API_KEY: 'dg-platform' });
  await h.server.tool('speech_set_key', { key: 'dg-own' });
  const st = await h.server.tool('speech_status', {});
  assert.equal(st.parsed.key_source, 'profile');
  await h.server.tool('speech_transcribe', { source: h.audio });
  const listen = h.stub.requests.find(x => x.url.includes('/v1/listen'));
  assert.equal(listen.authorization, 'Token dg-own');
});

test('empty personal key file does not shadow the platform key', async (t) => {
  const h = await harness(t, { DEEPGRAM_API_KEY: 'dg-platform' });
  fs.mkdirSync(path.dirname(h.keyFile), { recursive: true });
  fs.writeFileSync(h.keyFile, '  \n');
  const st = await h.server.tool('speech_status', {});
  assert.equal(st.parsed.key_source, 'platform');
});

test('neither key → key_missing, key_source null', async (t) => {
  const h = await harness(t);
  const st = await h.server.tool('speech_status', {});
  assert.equal(st.parsed.key_present, false);
  assert.equal(st.parsed.key_source, null);
  const res = await h.server.tool('speech_transcribe', { source: h.audio });
  assert.equal(res.parsed.error, 'key_missing');
});
