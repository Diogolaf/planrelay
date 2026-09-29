import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '../../src/core/config.js';
import { tempDir } from '../helpers.js';

function withConfig(obj) {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.agentboard'));
  fs.writeFileSync(path.join(root, '.agentboard', 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  return root;
}

test('defaults when there is no config file', () => {
  assert.deepEqual(loadConfig(tempDir()), DEFAULTS);
  assert.deepEqual(DEFAULTS, {
    agentTasksNeedApproval: true, locks: 'auto', lockMinutes: 30, claimTimeoutHours: 24, idleMinutes: 15, maxPings: 8,
  });
});

test('valid values override defaults', () => {
  const cfg = loadConfig(withConfig({ agentTasksNeedApproval: false, locks: 'off', maxPings: 3 }));
  assert.equal(cfg.agentTasksNeedApproval, false);
  assert.equal(cfg.locks, 'off');
  assert.equal(cfg.maxPings, 3);
  assert.equal(cfg.lockMinutes, 30);
});

test('wrong types, unknown keys, bad enum values and bad JSON fall back to defaults', () => {
  assert.deepEqual(loadConfig(withConfig({ lockMinutes: '5', locks: 'sometimes', extra: 1 })), DEFAULTS);
  assert.deepEqual(loadConfig(withConfig('{not json')), DEFAULTS);
  assert.deepEqual(loadConfig(withConfig({ maxPings: -2, idleMinutes: 0 })), DEFAULTS);
});
