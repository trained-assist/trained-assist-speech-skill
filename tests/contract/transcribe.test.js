'use strict';
// S3: speech_transcribe contract — the real stdio MCP server against a loopback
// Deepgram stub. Asserts the request the platform actually sends, the response shape,
// every typed error, retry, and that a downloaded temp file never survives.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMcp } = require('../helpers/mcp');
const { startStub, OGG_BYTES, MUTATED } = require('../helpers/stub-deepgram');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-tr-'));
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

// Start server + stub; ensure the key exists unless `withKey` is false.
async function harness(t, { withKey = true, stubOpts = {} } = {}) {
  const sb = sandbox();
  const stub = await startStub(stubOpts);
  const env = {
    AGENT_TOKENS_DIR: sb.tokens,
    USER_ID: 'tr-user',
    TMPDIR: sb.tmp,
    DEEPGRAM_API_HOST: stub.host,
    HOME: sb.root,
  };
  const server = await startMcp({ env });
  if (withKey) {
    const r = await server.tool('speech_set_key', { key: 'dg-test-key' });
    assert.equal(r.parsed.saved, true, r.text);
  }
  t.after(() => {
    server.stop();
    stub.close();
    fs.rmSync(sb.root, { recursive: true, force: true });
  });
  return { sb, stub, server, audio: (n) => audioFixture(sb.root, n) };
}

function queryOf(url) {
  return new URL('http://x' + url.slice(url.indexOf('/'))).searchParams;
}

test('default language=ru; request carries model=nova-2 & smart_format=true; response shape', async (t) => {
  const h = await harness(t);
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(res.isError, false, res.text);
  const r = res.parsed;
  assert.equal(typeof r.text, 'string');
  assert.ok(r.text.trim().length > 0);
  assert.equal(r.text, MUTATED);
  assert.equal(r.duration, 312.4);
  assert.equal(r.language, 'ru');
  assert.ok(r.cost_hint && typeof r.cost_hint === 'object');
  assert.equal(r.cost_hint.model, 'nova-2');
  assert.equal(r.cost_hint.duration_sec, 312.4);
  assert.match(r.cost_hint.note, /тариф|цена/i);
  assert.ok(!('segments' in r) && !('speakers' in r), 'Ф0 must not expose segments/speakers');

  const listen = h.stub.requests.find(x => x.url.includes('/v1/listen'));
  assert.ok(listen, 'stub saw no listen request');
  const q = queryOf(listen.url);
  assert.equal(q.get('model'), 'nova-2');
  assert.equal(q.get('smart_format'), 'true');
  assert.equal(q.get('language'), 'ru');
});

test('language=auto → detect_language=true (no language param)', async (t) => {
  const h = await harness(t);
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg'), language: 'auto' });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed.language, 'auto');
  const q = queryOf(h.stub.requests.find(x => x.url.includes('/v1/listen')).url);
  assert.equal(q.get('detect_language'), 'true');
  assert.equal(q.get('language'), null);
});

test('diarize:true / non-empty keywords / non-nova-2 model → typed feature_disabled', async (t) => {
  const h = await harness(t);
  const src = h.audio('a.ogg');
  for (const args of [{ diarize: true }, { keywords: ['Сколково'] }, { model: 'nova-3' }]) {
    const res = await h.server.tool('speech_transcribe', { source: src, ...args });
    assert.equal(res.parsed && res.parsed.error, 'feature_disabled', `${JSON.stringify(args)} → ${res.text}`);
    assert.ok(res.parsed.hint, 'feature_disabled must carry a hint');
  }
});

test('video container → unsupported_source (by extension, before any network)', async (t) => {
  const h = await harness(t);
  const v = path.join(h.sb.root, 'clip.mp4');
  fs.writeFileSync(v, Buffer.from('0000'));
  const res = await h.server.tool('speech_transcribe', { source: v });
  assert.equal(res.parsed && res.parsed.error, 'unsupported_source', res.text);
  assert.equal(h.stub.requests.length, 0, 'video guard must not hit Deepgram');
});

test('missing key → key_missing (not a crash)', async (t) => {
  const h = await harness(t, { withKey: false });
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed && res.parsed.error, 'key_missing', res.text);
});

test('URL source is downloaded and the temp file is removed in finally', async (t) => {
  const h = await harness(t);
  const res = await h.server.tool('speech_transcribe', { source: `${h.stub.host}/fixture.ogg` });
  assert.equal(res.isError, false, res.text);
  assert.equal(res.parsed.text, MUTATED);
  assert.deepStrictEqual(fs.readdirSync(h.sb.tmp), [], 'TMPDIR must be empty after the call');
});

test('unreachable URL → typed source_unavailable, no temp file left', async (t) => {
  const h = await harness(t);
  const res = await h.server.tool('speech_transcribe', { source: 'http://127.0.0.1:1/nothing.ogg' });
  assert.ok(res.parsed && ['source_unavailable', 'upstream_error'].includes(res.parsed.error), res.text);
  assert.deepStrictEqual(fs.readdirSync(h.sb.tmp), []);
});

test('5xx → exactly one retry → upstream_error', async (t) => {
  const h = await harness(t, {
    stubOpts: { handler: (req, res) => { if (req.method === 'POST') { req.resume(); res.writeHead(500); res.end('boom'); } else { res.writeHead(404); res.end(); } } },
  });
  const started = Date.now();
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  const elapsed = Date.now() - started;
  assert.equal(res.parsed && res.parsed.error, 'upstream_error', res.text);
  const listens = h.stub.requests.filter(x => x.url.includes('/v1/listen'));
  assert.equal(listens.length, 2, `expected 1 retry (2 attempts), saw ${listens.length}`);
  assert.ok(elapsed >= 900, `retry must pause (~1s), elapsed=${elapsed}ms`);
});

test('empty transcript → audio_empty', async (t) => {
  const h = await harness(t, {
    stubOpts: { body: { metadata: { duration: 3 }, results: { channels: [{ alternatives: [{ transcript: '' }] }] } } },
  });
  const res = await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  assert.equal(res.parsed && res.parsed.error, 'audio_empty', res.text);
});

test('unrecognised file type → unsupported_format; empty source → unsupported_source', async (t) => {
  const h = await harness(t);
  const bin = path.join(h.sb.root, 'blob.dat');
  fs.writeFileSync(bin, Buffer.from('not audio at all, honest'));
  const r1 = await h.server.tool('speech_transcribe', { source: bin });
  assert.equal(r1.parsed && r1.parsed.error, 'unsupported_format', r1.text);
  const r2 = await h.server.tool('speech_transcribe', { source: '   ' });
  assert.equal(r2.parsed && r2.parsed.error, 'unsupported_source', r2.text);
  assert.equal(h.stub.requests.length, 0, 'input errors must not hit Deepgram');
});

test('calls.json records the call metadata (no text) after success', async (t) => {
  const h = await harness(t);
  await h.server.tool('speech_transcribe', { source: h.audio('a.ogg') });
  const callsFile = path.join(h.sb.tokens, 'tr-user', 'deepgram', 'calls.json');
  const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  assert.equal(calls[0].duration_sec, 312.4);
  assert.equal(calls[0].chars, MUTATED.length);
  assert.ok(!fs.readFileSync(callsFile, 'utf8').includes(MUTATED), 'the transcript itself must not be journaled');
});
