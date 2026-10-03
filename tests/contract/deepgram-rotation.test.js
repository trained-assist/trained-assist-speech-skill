'use strict';
// Rotation end-to-end: the real MCP server against a loopback Deepgram stub that
// rejects the first key (401) and accepts the second. Asserts the call succeeds on
// the fallback key, that the quota journal is written, and that the tool surface
// (speech_add_key / speech_list_keys) behaves.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');
const { startMcp } = require('../helpers/mcp');
const { startStub, OGG_BYTES } = require('../helpers/stub-deepgram');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-rot-'));
  const tokens = path.join(root, 'tokens');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tokens, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  return { root, tokens, tmp };
}

function audioFixture(root, name = 'sample.ogg') {
  const p = path.join(root, name);
  fs.writeFileSync(p, OGG_BYTES);
  return p;
}

// Stub that 401s `bad-key` and 200s everything else, recording which key was used.
function selectiveStub() {
  const used = [];
  return startStub({
    handler(req, res) {
      const auth = req.headers.authorization || '';
      const key = auth.replace('Token ', '');
      used.push(key);
      if (key === 'bad-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ err_code: 'INVALID_AUTH', err_msg: 'bad key' }));
        return;
      }
      req.resume();
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      });
      res.end(JSON.stringify({
        metadata: { duration: 1.5, channels: 1 },
        results: { channels: [{ alternatives: [{ transcript: 'rotated ok', paragraphs: { transcript: 'rotated ok' } }] }] },
      }));
    },
  }).then((stub) => ({ stub, used }));
}

async function harness(t, { keys = [] } = {}) {
  const sb = sandbox();
  const { stub, used } = await selectiveStub();
  const env = {
    AGENT_TOKENS_DIR: sb.tokens,
    USER_ID: 'rot-user',
    TMPDIR: sb.tmp,
    DEEPGRAM_API_HOST: stub.host,
    HOME: sb.root,
  };
  const server = await startMcp({ env });
  for (const k of keys) {
    const r = await server.tool('speech_add_key', { key: k });
    assert.equal(r.parsed.saved, true, r.text);
  }
  t.after(() => {
    server.stop();
    stub.close();
    fs.rmSync(sb.root, { recursive: true, force: true });
  });
  return { sb, stub, server, used, audio: (n) => audioFixture(sb.root, n) };
}

test('transcribe rotates past a rejected key to the next one', async (t) => {
  const h = await harness(t, { keys: ['bad-key', 'good-key'] });
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed.text, 'rotated ok');
  assert.ok(h.used.includes('bad-key'), 'the first key must have been tried');
  assert.ok(h.used.includes('good-key'), 'the second key must have been used');
});

test('transcribe reports every key exhausted when all are rejected', async (t) => {
  const h = await harness(t, { keys: ['bad-key'] });
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(res.parsed.error, 'upstream_error', res.text);
  assert.match(res.text, /401|отклонил/);
  assert.ok(Array.isArray(res.parsed.tried) && res.parsed.tried.length === 1);
});

test('speech_add_key appends without wiping; duplicate is refused', async (t) => {
  const h = await harness(t, { keys: ['k1'] });
  const add = await h.server.tool('speech_add_key', { key: 'k2' });
  assert.equal(add.parsed.count, 2, add.text);

  const dup = await h.server.tool('speech_add_key', { key: 'k2' });
  assert.equal(dup.parsed.error, 'key_duplicate', dup.text);

  // A transcribe call journals the quota from the stub's X-RateLimit headers.
  const tr = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(tr.isError, false, tr.text);

  const list = await h.server.tool('speech_list_keys', {});
  assert.equal(list.parsed.count, 2, list.text);
  assert.strictEqual(list.parsed.keys[0].remaining, 42, 'quota journaled from the stub response');
  assert.strictEqual(list.parsed.keys[0].exhausted, false);
});

test('speech_list_keys: no profile keys → platform fallback note', async (t) => {
  const h = await harness(t);
  const list = await h.server.tool('speech_list_keys', {});
  assert.equal(list.parsed.count, 0, list.text);
  assert.match(list.text, /платформенный/);
});

test('speech_status reports rotation state', async (t) => {
  const h = await harness(t, { keys: ['k1', 'k2'] });
  const st = await h.server.tool('speech_status', {});
  assert.equal(st.parsed.key_present, true);
  assert.equal(st.parsed.key_count, 2);
  assert.equal(st.parsed.rotating, true);
  assert.match(st.text, /ротирует/);
});

test('quota journal survives across calls (keys.json on disk)', async (t) => {
  const h = await harness(t, { keys: ['k1', 'k2'] });
  await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  const journalPath = path.join(h.sb.tokens, 'rot-user', 'deepgram', 'keys.json');
  assert.ok(fs.existsSync(journalPath), 'quota journal must be written');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.ok(journal.k1 && typeof journal.k1.remaining === 'number', 'k1 quota recorded');
});
