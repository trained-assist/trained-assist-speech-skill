'use strict';
// Speech provider's own v1 action manifest — metadata only, consumed by core's
// ActionProviderRegistry.register() (trained-assist-agent src/action-provider-registry.js).
// Registration is not authorization: this file declares policy (effect/approval/retry
// safety/allowed triggers), it does not grant it. Core still authenticates, binds
// profile/project capabilities and records durable history before any effect runs.
//
// Policy for Ф0 (docs/user-scenarios/speech/03-proposal-design.md §2.9):
//   speech_transcribe — write/idempotent, user only: recognition is not cron-schedulable
//                       yet (Ф0 explicitly keeps planned execution at zero).
//   speech_set_key     — write/idempotent, user only: credentials, never a scheduler.
//   speech_status      — read/read_only: cheap, safe from any trigger.
// Anything NOT listed below defaults to the conservative { write, requiresApproval:true,
// unsafe, ['user'] } — so a newly added tool can never inherit a permissive policy
// just by existing.

const registry = require('../src/mcp-skills/registry');

const READ_ONLY = ['user', 'cron', 'durable_task'];
const USER_ONLY = ['user'];

const POLICY = {
  speech_transcribe: { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  speech_set_key:    { effect: 'write', requiresApproval: false, retrySafety: 'idempotent', allowedTriggers: USER_ONLY },
  speech_status:     { effect: 'read',  requiresApproval: false, retrySafety: 'read_only', allowedTriggers: READ_ONLY },
};

const DEFAULT_POLICY = { effect: 'write', requiresApproval: true, retrySafety: 'unsafe', allowedTriggers: USER_ONLY };

function buildManifest(providerId = 'speech') {
  const actions = registry.listAllTools().map(tool => {
    const policy = POLICY[tool.name] || DEFAULT_POLICY;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      allowedTriggers: policy.allowedTriggers,
      effect: policy.effect,
      requiresApproval: policy.requiresApproval,
      retrySafety: policy.retrySafety,
      ...(policy.schedule ? { schedule: policy.schedule } : {}),
    };
  });
  return { version: 1, providerId, actions };
}

// Core's strict v1 descriptor omits MCP-only description metadata.
function buildActionManifest() {
  const catalog = buildManifest();
  return { ...catalog, actions: catalog.actions.map(({ description, ...action }) => action) };
}

function writeAll() {
  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(__dirname, '../provider-manifest.json'), JSON.stringify(buildManifest(), null, 2) + '\n');
  fs.writeFileSync(path.join(__dirname, '../action-provider-manifest.json'), JSON.stringify(buildActionManifest(), null, 2) + '\n');
}

function checkAll() {
  const fs = require('fs');
  const path = require('path');
  const diffs = [];
  for (const [file, built] of [
    ['provider-manifest.json', buildManifest()],
    ['action-provider-manifest.json', buildActionManifest()],
  ]) {
    const p = path.join(__dirname, '..', file);
    if (!fs.existsSync(p)) { diffs.push(`${file} missing`); continue; }
    const onDisk = fs.readFileSync(p, 'utf8');
    const want = JSON.stringify(built, null, 2) + '\n';
    if (onDisk !== want) diffs.push(`${file} is out of date with the tool registry — run \`npm run build:manifest\``);
  }
  return diffs;
}

module.exports = { buildManifest, buildActionManifest, POLICY, DEFAULT_POLICY, writeAll, checkAll };

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const diffs = checkAll();
    for (const d of diffs) console.error(`[error] ${d}`);
    console.log(diffs.length ? `FAIL (${diffs.length} issues)` : 'PASS');
    process.exit(diffs.length ? 1 : 0);
  }
  writeAll();
  console.log('provider-manifest.json + action-provider-manifest.json written');
}
