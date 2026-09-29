import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent, endAgent } from '../../src/core/agents.js';
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
const mode = (locks) => ({ cfg: { ...DEFAULTS, locks } });

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

test('the asking agent counts as active, even after a long turn without hook calls', () => {
  const reg = twoAgents();
  reg.agents.a.lastSeen = T0 - 60 * MIN; // idle by its lastSeen; b is the only active agent
  assert.equal(ask(reg).agent.id, 'b');
  delete reg.agents.a; // not even registered
  assert.equal(ask(reg).agent.id, 'b');
});

test('modes: auto locks for an active owner, always for any owner not gone, off never', () => {
  const reg = twoAgents();
  assert.equal(ask(reg, mode('off')), null);
  assert.equal(ask(reg, mode('auto')).agent.id, 'b');
  assert.equal(ask(reg, mode('always')).agent.id, 'b');
  reg.agents.b.lastSeen = T0 - 20 * MIN; // b is idle
  assert.equal(ask(reg, mode('auto')), null);
  assert.equal(ask(reg, mode('always')).agent.id, 'b');
  assert.equal(ask(reg, mode('off')), null);
  endAgent(reg, 'b', T0); // b is gone
  assert.equal(ask(reg, mode('auto')), null);
  assert.equal(ask(reg, mode('always')), null);
  delete reg.agents.b; // b is forgotten
  assert.equal(ask(reg, mode('always')), null);
});

test('two agents without a task collide on the same file', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 'a' }, T0);
  touchAgent(reg, { id: 'b' }, T0);
  recordTouch(reg, { agentId: 'b', taskId: null, file: 'src/x.js', now: T0 });
  const hit = ask(reg, { taskId: null });
  assert.equal(hit.agent.id, 'b');
  assert.equal(hit.task, null);
  assert.equal(ask(reg).agent.id, 'b'); // a task against no task too
});

test('a touch whose time is not usable or lies far ahead never locks', () => {
  const reg = twoAgents();
  const now = T0 + MIN;
  reg.touches['src/x.js'].at = now + 29 * MIN; // a little ahead: another host's clock
  assert.equal(ask(reg).agent.id, 'b');
  reg.touches['src/x.js'].at = now + 31 * MIN;
  assert.equal(ask(reg), null);
  reg.touches['src/x.js'].at = 'soon';
  assert.equal(ask(reg), null);
  reg.touches['src/x.js'].at = Number.NaN;
  assert.equal(ask(reg), null);
  reg.touches['src/x.js'] = null;
  assert.equal(ask(reg), null);
});

test('recordTouch keys by path and marks task activity', () => {
  const reg = emptyRegistry();
  recordTouch(reg, { agentId: 'a', taskId: 3, file: 'src/y.js', now: T0 });
  assert.deepEqual(reg.touches['src/y.js'], { agent: 'a', task: 3, at: T0 });
  assert.equal(reg.activity[3], T0);
});

test('inherited property names are not treated as touched files or agents', () => {
  const reg = twoAgents();
  assert.equal(ask(reg, { file: 'constructor' }), null);
  assert.equal(ask(reg, { file: '__proto__' }), null);
  recordTouch(reg, { agentId: 'toString', taskId: 1, file: 'src/z.js', now: T0 });
  assert.equal(ask(reg, { file: 'src/z.js', ...mode('always') }), null);
});
