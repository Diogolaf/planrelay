import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, updateTask, BoardError } from '../../src/core/ops.js';
import { columnOf } from '../../src/core/derive.js';
import { DEFAULTS } from '../../src/core/config.js';
import { ctxWith, apply } from './ops-helpers.js';

test('a task the human asked for is approved and Ready', () => {
  const ctx = ctxWith();
  const out = apply(ctx, createTask(ctx, { title: '  Sign in with Google ', requestedByHuman: true }));
  const t = ctx.state.tasks[out.result.id];
  assert.equal(out.result.id, 1);
  assert.equal(t.title, 'Sign in with Google');
  assert.equal(t.origin, 'human');
  assert.equal(t.createdBy, 'human');
  assert.equal(t.rank, 1);
  assert.equal(columnOf(t, ctx.state.tasks), 'ready');
});

test('a task an agent suggests waits in Backlog unless the config says otherwise', () => {
  const ctx = ctxWith();
  const t = ctx.state.tasks[apply(ctx, createTask(ctx, { title: 'Cache photos', requestedByHuman: false })).result.id];
  assert.equal(t.origin, 'agent');
  assert.equal(t.createdBy, 'a1');
  assert.equal(columnOf(t, ctx.state.tasks), 'backlog');
  const open = ctxWith({ cfg: { ...DEFAULTS, agentTasksNeedApproval: false } });
  const t2 = open.state.tasks[apply(open, createTask(open, { title: 'X' })).result.id];
  assert.equal(t2.approved, true);
});

test('epics are always approved, cannot have dependencies, and nest one level', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, kind: 'epic', title: 'Search' }, { id: 2, kind: 'epic', title: 'Filters', parent: 1 }, { id: 3 }] });
  const epic = apply(ctx, createTask(ctx, { title: 'Accounts', kind: 'epic' }));
  assert.equal(ctx.state.tasks[epic.result.id].approved, true);
  assert.throws(() => createTask(ctx, { title: 'E', kind: 'epic', dependsOn: [3] }), /Epics cannot have dependencies/);
  assert.throws(() => createTask(ctx, { title: 'E', kind: 'epic', parent: 2 }), /one level only/);
  assert.throws(() => createTask(ctx, { title: 'T', parent: 3 }), /#3 is not an epic/);
  apply(ctx, createTask(ctx, { title: 'Vegetarian filter', parent: 2, requestedByHuman: true }));
});

test('dependencies must exist, be tasks, and not form a cycle', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, dependsOn: [2] }, { id: 2 }, { id: 3, kind: 'epic' }] });
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: [99] }), /#99 does not exist/);
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: [3] }), /dependencies link tasks only/);
  assert.throws(() => updateTask(ctx, { id: 2, addDependsOn: [1] }), /cycle/);
  assert.throws(() => updateTask(ctx, { id: 2, addDependsOn: [2] }), /cannot depend on itself/);
});

test('input validation errors are BoardErrors with guidance', () => {
  const ctx = ctxWith();
  assert.throws(() => createTask(ctx, { title: '   ' }), BoardError);
  assert.throws(() => createTask(ctx, { title: 'x'.repeat(201) }), /too long/);
  assert.throws(() => createTask(ctx, { title: 'T', kind: 'story' }), /kind must be/);
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: ['1'] }), /whole numbers/);
});

test('update edits fields, labels and dependencies; approval is its own event', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, approved: false, origin: 'agent' }, { id: 2 }, { id: 3 }] });
  const out = apply(ctx, updateTask(ctx, {
    id: 1, title: 'Renamed', labels: [' bug ', 'bug', ''], addDependsOn: [2, 3], approved: true,
    links: [{ title: 'Plan', target: 'docs/plan.md' }],
  }));
  assert.deepEqual(out.events.map((e) => e.type), ['task.updated', 'task.approved']);
  const t = ctx.state.tasks[1];
  assert.equal(t.title, 'Renamed');
  assert.deepEqual(t.labels, ['bug']);
  assert.deepEqual(t.dependsOn, [2, 3]);
  assert.deepEqual(t.links, [{ title: 'Plan', target: 'docs/plan.md' }]);
  assert.equal(t.approved, true);
  apply(ctx, updateTask(ctx, { id: 1, removeDependsOn: [2] }));
  assert.deepEqual(ctx.state.tasks[1].dependsOn, [3]);
});

test('nothing to update, and moving a claimed task to Backlog, are refused', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a2' }] });
  assert.throws(() => updateTask(ctx, { id: 1 }), /Nothing to update/);
  assert.throws(() => updateTask(ctx, { id: 1, approved: false }), /release it first/);
});

test('text fields are redacted', () => {
  const ctx = ctxWith();
  const secret = 'gh' + 'p_' + 'Z'.repeat(36);
  const out = apply(ctx, createTask(ctx, { title: 'Rotate key', description: `old ${secret}`, requestedByHuman: true }));
  assert.equal(ctx.state.tasks[out.result.id].description, 'old [REDACTED]');
});
