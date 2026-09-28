'use strict';
// S1 gate: the server answers initialize and lists its tools over stdio — the exact
// boundary writeMcpConfig() mounts. Everything else in the contract is behavioural
// (see keys/transcribe tests).
const test = require('node:test');
const assert = require('node:assert');
const { startMcp } = require('../helpers/mcp');

test('initialize + tools/list over stdio', async () => {
  const server = await startMcp();
  try {
    const list = await server.call('tools/list', {});
    assert.ok(list.result, JSON.stringify(list.error || {}));
    assert.ok(Array.isArray(list.result.tools));
    const names = list.result.tools.map(t => t.name).sort();
    for (const t of list.result.tools) {
      assert.ok(typeof t.description === 'string' && t.description.trim().length >= 20,
        `${t.name}: description too short`);
      assert.ok(t.inputSchema && typeof t.inputSchema === 'object', `${t.name}: no inputSchema`);
    }
    // Ф0 contract: one prefix for every tool (check-skill-contract warns otherwise).
    for (const n of names) assert.match(n, /^speech_/, `${n} must live under the speech_ prefix`);
  } finally {
    server.stop();
  }
});
