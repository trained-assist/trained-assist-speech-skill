'use strict';

const fs = require('fs');
const path = require('path');

// Spawn the skill's REAL src/mcp-skills/index.js over stdio and speak raw JSON-RPC
// to it — the same boundary the host (writeMcpConfig / check-mcp-conformance) uses.
// Returns { call, stop }. Every server gets an isolated env so tests never touch a
// real profile: tokens root + TMPDIR point into `sandbox` (created if missing).
async function startMcp({ env = {} } = {}) {
  const { spawn } = require('child_process');
  const entry = path.join(__dirname, '..', '..', 'src', 'mcp-skills', 'index.js');
  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', () => {
    for (const [, p] of pending) p.reject(new Error(`server exited; stderr: ${stderr.slice(-300)}`));
    pending.clear();
  });

  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out; stderr: ${stderr.slice(-500)}`)); }, 30000);
    pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tests', version: '1' } });
  // Notifications are not answered; swallow write errors after shutdown.
  return {
    call,
    stop: () => { try { child.stdin.end(); } catch { /* ignore */ } setTimeout(() => child.kill('SIGKILL'), 50).unref(); },
    text: (msg) => (msg?.result?.content || []).filter(c => c && c.type === 'text').map(c => String(c.text || '')).join(''),
    async tool(name, args) {
      const res = await call('tools/call', { name, arguments: args || {} });
      const text = (res?.result?.content || []).filter(c => c && c.type === 'text').map(c => String(c.text || '')).join('');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { text, parsed, isError: !!res?.error || !!res?.result?.isError };
    },
  };
}

module.exports = { startMcp };
