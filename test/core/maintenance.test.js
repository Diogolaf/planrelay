import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, newTask } from '../../src/core/reduce.js';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent, endAgent } from '../../src/core/agents.js';
import { maintenance, inheritClaim } from '../../src/core/maintenance.js';
import { T0, MIN, HOUR } from '../helpers.js';

const io = (existing = ['/w/a', '/w/b']) => ({ exists: (p) => existing.includes(p), alive: () => true });

function setup() {
  const state = emptyState();
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a', pid: 1 }, T0);
  state.tasks[1] = newTask({ id: 1, title: 'One', assignee: 's1', claim: { folder: '/w/a', since: T0 } });
  return { state, reg };
}

test('a fresh claim is left alone', () => {
  const { state, reg } = setup();
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR, io()), []);
});

test('a claim whose folder disappeared is released with a system message', () => {
  const { state, reg } = setup();
  const events = maintenance(state, reg, DEFAULTS, T0 + MIN, io(['/w/b']));
  assert.deepEqual(events.map((e) => e.type), ['message.posted', 'task.released']);
  assert.equal(events[0].data.message.text, 'Released: the working folder was removed.');
  assert.deepEqual(events[1].data, { id: 1, reason: 'folder-missing' });
});

test('a claim without activity for claimTimeoutHours is released', () => {
  const { state, reg } = setup();
  const events = maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  assert.equal(events[1].data.reason, 'timeout');
  assert.equal(events[0].data.message.text, 'Released after 24 h without activity.');
  reg.activity[1] = T0 + 20 * HOUR;
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io()), []);
});

test('sessions whose host process died are ended', () => {
  const { state, reg } = setup();
  maintenance(state, reg, DEFAULTS, T0 + MIN, { exists: () => true, alive: () => false });
  assert.equal(reg.agents.s1.endedAt, T0 + MIN);
});

test('old ended agents without claims, stale touches and finished activity are pruned', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 'old' }, T0);
  endAgent(reg, 'old', T0);
  reg.touches['src/a.js'] = { agent: 's1', task: 1, at: T0 };
  reg.activity[1] = T0;
  reg.activity[9] = T0;
  reg.activity[1] = T0 + 8 * 24 * HOUR;
  maintenance(state, reg, DEFAULTS, T0 + 8 * 24 * HOUR, io());
  assert.equal(reg.agents.old, undefined);
  assert.ok(reg.agents.s1);
  assert.deepEqual(reg.touches, {});
  assert.deepEqual(Object.keys(reg.activity), ['1']);
});

test('a claim with a corrupt since is not released instantly', () => {
  const { state, reg } = setup();
  state.tasks[1].claim.since = 'garbage';
  reg.agents.s1.lastSeen = T0 + HOUR;
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + 2 * HOUR, io()), []);
});

test('a new session inherits a claim left in its folder by a gone agent', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + MIN); // registered while Amber is live, so it is Jade
  endAgent(reg, 's1', T0 + 2 * MIN);
  const events = inheritClaim(state, reg, 's2', '/w/a');
  assert.deepEqual(events.map((e) => e.type), ['message.posted', 'task.claimed']);
  assert.equal(events[0].data.message.text, 'Jade continues this task in the same folder (taken over from Amber).');
  assert.deepEqual(events[1].data, { id: 1, agent: 's2', folder: '/w/a' });
});

test('a successor that reused the same name gets a plain continuation message', () => {
  const { state, reg } = setup();
  endAgent(reg, 's1', T0 + MIN);
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + 2 * MIN); // "Amber" is free again
  assert.equal(inheritClaim(state, reg, 's2', '/w/a')[0].data.message.text, 'Amber continues this task in a new session.');
});

test('no inheritance from a live agent, another folder, or when already holding a claim', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0);
  assert.deepEqual(inheritClaim(state, reg, 's2', '/w/a'), []);
  endAgent(reg, 's1', T0);
  assert.deepEqual(inheritClaim(state, reg, 's2', '/w/b'), []);
  state.tasks[2] = newTask({ id: 2, assignee: 's2', claim: { folder: '/w/a', since: T0 } });
  assert.deepEqual(inheritClaim(state, reg, 's2', '/w/a'), []);
});
