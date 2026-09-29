import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent } from '../../src/core/agents.js';
import { lockConflict, recordTouch } from '../../src/core/locks.js';
import { T0, MIN } from '../helpers.js';

function twoAgents() {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 'a' }, T0);
  touchAgent(reg, { id: 'b' }, T0);
  recordTouch(reg, { agentId: 'b', taskId: 12, file: 'src/x.js', now: T0 });
  return reg;
}
const ask = (reg, over = {}) =>
  lockConflict({ reg, cfg: DEFAULTS, now: T0 + MIN, agentId: 'a', taskId: 14, file: 'src/x.js', ...over });

test('another active agent on a different task holds a recently touched file', () => {
  const hit = ask(twoAgents());
  assert.equal(hit.agent.id, 'b');
  assert.equal(hit.task, 12);
});

test('no conflict: same task, own touch, old touch, idle owner, untouched file', () => {
  const reg = twoAgents();
  assert.equal(ask(reg, { taskId: 12 }), null);
  assert.equal(ask(reg, { agentId: 'b' }), null);
  assert.equal(ask(reg, { now: T0 + 31 * MIN }), null);
  assert.equal(ask(reg, { file: 'src/other.js' }), null);
  reg.agents.b.lastSeen = T0 - 20 * MIN;
  assert.equal(ask(reg), null);
});

test('config: off never locks; auto needs two active agents; always ignores the count', () => {
  const reg = twoAgents();
  assert.equal(ask(reg, { cfg: { ...DEFAULTS, locks: 'off' } }), null);
  reg.agents.a.lastSeen = T0 - 20 * MIN; // only b is active now
  assert.equal(ask(reg), null);
  assert.equal(ask(reg, { cfg: { ...DEFAULTS, locks: 'always' } }).agent.id, 'b');
});

test('recordTouch keys by path and marks task activity', () => {
  const reg = emptyRegistry();
  recordTouch(reg, { agentId: 'a', taskId: 3, file: 'src/y.js', now: T0 });
  assert.deepEqual(reg.touches['src/y.js'], { agent: 'a', task: 3, at: T0 });
  assert.equal(reg.activity[3], T0);
});

test('inherited property names are not treated as touched files', () => {
  const reg = twoAgents();
  assert.equal(ask(reg, { file: 'constructor' }), null);
  assert.equal(ask(reg, { file: '__proto__' }), null);
});
