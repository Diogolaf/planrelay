import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent, endAgent, statusOf, resolveAgentId, activeCount, nameOf, PALETTE } from '../../src/core/agents.js';
import { T0, MIN } from '../helpers.js';

test('new agents get the first free palette name and color', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1', folder: '/w/a', pid: 10 }, T0);
  const b = touchAgent(reg, { id: 's2', folder: '/w/b', pid: 11 }, T0);
  assert.equal(a.name, 'Amber');
  assert.equal(a.color, PALETTE[0][1]);
  assert.equal(b.name, 'Jade');
  endAgent(reg, 's1', T0 + 1);
  assert.equal(touchAgent(reg, { id: 's3' }, T0 + 2).name, 'Amber');
});

test('when every name is taken, names get a number', () => {
  const reg = emptyRegistry();
  for (let i = 0; i < PALETTE.length; i++) touchAgent(reg, { id: `s${i}` }, T0);
  assert.equal(touchAgent(reg, { id: 'extra' }, T0).name, 'Amber 2');
});

test('touch refreshes lastSeen, revives an ended agent and keeps its name', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w' }, T0);
  endAgent(reg, 's1', T0 + MIN);
  const again = touchAgent(reg, { id: 's1', pid: 42 }, T0 + 2 * MIN);
  assert.equal(again.endedAt, null);
  assert.equal(again.lastSeen, T0 + 2 * MIN);
  assert.equal(again.pid, 42);
  assert.equal(again.folder, '/w');
  assert.equal(again.name, 'Amber');
});

test('status: active, idle, gone', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1' }, T0);
  assert.equal(statusOf(a, T0 + 14 * MIN, DEFAULTS), 'active');
  assert.equal(statusOf(a, T0 + 16 * MIN, DEFAULTS), 'idle');
  endAgent(reg, 's1', T0);
  assert.equal(statusOf(a, T0, DEFAULTS), 'gone');
  assert.equal(statusOf(undefined, T0, DEFAULTS), 'gone');
  touchAgent(reg, { id: 's2' }, T0);
  touchAgent(reg, { id: 's3' }, T0 - 20 * MIN);
  assert.equal(activeCount(reg, T0, DEFAULTS), 1);
});

test('MCP identity: session id, then pid, then folder (§4)', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', pid: 100, folder: '/w/a' }, T0);
  touchAgent(reg, { id: 's2', pid: 200, folder: '/w/b' }, T0 + 1);
  assert.equal(resolveAgentId(reg, { sessionId: 's2', pid: 100, folder: '/w/a' }), 's2');
  assert.equal(resolveAgentId(reg, { sessionId: 'unknown', pid: 100 }), 's1');
  assert.equal(resolveAgentId(reg, { folder: '/w/b' }), 's2');
  endAgent(reg, 's2', T0 + 2);
  assert.equal(resolveAgentId(reg, { sessionId: 's2', folder: '/w/b' }), null);
});

test('nameOf', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1' }, T0);
  assert.equal(nameOf(reg, 's1'), 'Amber');
  assert.equal(nameOf(reg, 'human'), 'the human');
  assert.equal(nameOf(reg, 'system'), 'system');
  assert.equal(nameOf(reg, 'gone-long-ago'), 'an earlier agent');
});

test('ids like __proto__ or toString never reach Object.prototype', () => {
  const reg = emptyRegistry();
  assert.equal(resolveAgentId(reg, { sessionId: '__proto__' }), null);
  assert.equal(resolveAgentId(reg, { sessionId: 'toString' }), null);
  assert.equal(resolveAgentId(reg, { sessionId: 42 }), null);
  assert.equal(nameOf(reg, '__proto__'), 'an earlier agent');
  assert.equal(nameOf(reg, 'constructor'), 'an earlier agent');
  endAgent(reg, '__proto__', T0);
  assert.equal(Object.getPrototypeOf(reg.agents), Object.prototype);
  assert.throws(() => touchAgent(reg, { id: 7 }, T0), TypeError);
  assert.throws(() => touchAgent(reg, {}, T0), TypeError);
  const a = touchAgent(reg, { id: '__proto__' }, T0);
  assert.equal(Object.getPrototypeOf(reg.agents), Object.prototype);
  assert.equal(Object.hasOwn(reg.agents, '__proto__'), true);
  assert.equal(a.id, '__proto__');
  assert.equal(resolveAgentId(reg, { sessionId: '__proto__' }), '__proto__');
  assert.equal(nameOf(reg, '__proto__'), 'Amber');
});
