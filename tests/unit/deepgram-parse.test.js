'use strict';
// Pure-function units — no server, no network.
const test = require('node:test');
const assert = require('node:assert');
const { parseResponse, buildQuery } = require('../../src/deepgram/client');
const mime = require('../../src/audio/mime');

test('parseResponse prefers paragraphs.transcript, falls back to alternatives.transcript', () => {
  const body = JSON.stringify({ metadata: { duration: 12.5 }, results: { channels: [{ alternatives: [{ transcript: 'flat', paragraphs: { transcript: 'para' } }] }] } });
  assert.deepStrictEqual(parseResponse(body), { text: 'para', duration: 12.5 });
  const noPara = JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'flat' }] }] } });
  assert.deepStrictEqual(parseResponse(noPara), { text: 'flat', duration: null });
});

test('parseResponse: empty text → audio_empty, bad JSON → upstream_error, duration null-safe', () => {
  const empty = parseResponse(JSON.stringify({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: '   ' }] }] } }));
  assert.equal(empty.error, 'audio_empty');
  assert.equal(parseResponse('not json').error, 'upstream_error');
  const noDur = parseResponse(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'x' }] }] } }));
  assert.strictEqual(noDur.duration, null);
});

test('buildQuery: model + smart_format always; language vs detect_language', () => {
  const ru = buildQuery({ model: 'nova-2', language: 'ru' });
  assert.equal(ru.get('model'), 'nova-2');
  assert.equal(ru.get('smart_format'), 'true');
  assert.equal(ru.get('language'), 'ru');
  assert.equal(ru.get('detect_language'), null);
  const auto = buildQuery({ model: 'nova-2', language: 'auto' });
  assert.equal(auto.get('detect_language'), 'true');
  assert.equal(auto.get('language'), null);
});

test('mime: video containers by extension, audio content types, magic fallback', () => {
  for (const v of ['a.mp4', 'b.MKV', 'c.mov', 'd.avi', 'e.webm/../x.mpg']) assert.equal(mime.isVideoContainer(v), true, v);
  assert.equal(mime.isVideoContainer('clip.ogg'), false);
  assert.equal(mime.isVideoContainer('https://x/y.mp4?token=1'), true, 'extension from URL pathname');
  assert.equal(mime.contentTypeFor('a.ogg', Buffer.alloc(0)), 'audio/ogg');
  assert.equal(mime.contentTypeFor('a.mp3', Buffer.alloc(0)), 'audio/mpeg');
  // no extension → magic bytes
  assert.equal(mime.contentTypeFor('download', Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])), 'audio/ogg');
  assert.equal(mime.contentTypeFor('download', Buffer.from('plain text, definitely not audio')), null);
  // ISO-BMFF (m4a / audio mp4) has no magic at offset 0 — the box header sits at
  // offset 4. tg-bot#319 stores intake files as an extensionless `data`, so without
  // this rule a user's .m4a voice memo would be rejected as unsupported_format
  // instead of being transcribed like it is today (the gateway sends its mime type).
  assert.equal(mime.contentTypeFor('download', Buffer.concat([
    Buffer.from([0, 0, 0, 20]), Buffer.from('ftypM4A '), Buffer.alloc(32),
  ])), 'audio/mp4');
});
