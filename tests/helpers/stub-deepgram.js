'use strict';
// Loopback Deepgram stub. No network, no key: the skill points at it through
// DEEPGRAM_API_HOST (a full origin — `http://127.0.0.1:<port>`).
const http = require('http');

const MUTATED = 'Привет!  Это тестовое голосовое сообщение, для песочницы.';
const OGG_BYTES = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(256, 7)]);

function defaultBody(text = MUTATED) {
  return {
    metadata: { duration: 312.4, channels: 1 },
    results: { channels: [{ alternatives: [{ transcript: text, paragraphs: { transcript: text } }] }] },
  };
}

// startStub({ handler }) — handler(req, res, count) overrides everything.
// Defaults: POST /v1/listen → 200 + transcript; GET /fixture.ogg → ogg bytes.
function startStub(opts = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (opts.handler) return opts.handler(req, res, requests.length);
    if (req.method === 'POST' && req.url.startsWith('/v1/listen')) {
      req.resume();
      const body = JSON.stringify(opts.body || defaultBody());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url.startsWith('/fixture.ogg')) {
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(OGG_BYTES);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      host: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => server.close(),
    }));
  });
}

module.exports = { startStub, defaultBody, OGG_BYTES, MUTATED };
