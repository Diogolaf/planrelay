import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, updateTask, messageEvent, BoardError } from '../../src/core/ops.js';
import { endAgent } from '../../src/core/agents.js';
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
  assert.throws(() => createTask(ctx, { title: 'T', parent: 3 }), /#3 is not an epic; only epics contain tasks — use dependsOn for order/);
  const inSub = apply(ctx, createTask(ctx, { title: 'Vegetarian filter', parent: 2, requestedByHuman: true }));
  const t = ctx.state.tasks[inSub.result.id];
  assert.deepEqual([t.kind, t.parent, t.approved, columnOf(t, ctx.state.tasks)], ['task', 2, true, 'ready']);
});

test('dependencies must exist, be tasks, and not form a cycle', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, dependsOn: [2] }, { id: 2 }, { id: 3, kind: 'epic' }] });
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: [99] }), /#99 does not exist/);
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: [3] }), /#3 is an epic; depend on the tasks inside it instead/);
  assert.throws(() => updateTask(ctx, { id: 2, addDependsOn: [1] }), /cycle/);
  assert.throws(() => updateTask(ctx, { id: 2, addDependsOn: [2] }), /cannot depend on itself/);
});

test('input validation errors are BoardErrors with guidance', () => {
  const ctx = ctxWith();
  assert.throws(() => createTask(ctx, { title: '   ' }), BoardError);
  assert.throws(() => createTask(ctx, { title: 'x'.repeat(201) }), /too long/);
  assert.throws(() => createTask(ctx, { title: 'T', kind: 'story' }), /kind must be/);
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: ['1'] }), /dependsOn must be a list of task numbers such as \[3, 4\] \(got "1"\)/);
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
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a2' }, { id: 2, assignee: 'a1' }, { id: 3, assignee: 'gone-agent', assigneeName: 'Cobalt' }] });
  assert.throws(
    () => updateTask(ctx, { id: 1 }),
    /^BoardError: Nothing to update\. Give #1 at least one of: title, description, parent, labels, links, rank, addDependsOn, removeDependsOn, approved\.$/,
  );
  assert.throws(() => updateTask(ctx, { id: 1, title: null, labels: undefined }), /Nothing to update/); // null means "not provided"
  assert.throws(() => updateTask(ctx, { id: 1, approved: false }), /^BoardError: #1 is claimed by Jade; ask them to release it first\.$/);
  assert.throws(() => updateTask(ctx, { id: 2, approved: false }), /^BoardError: You hold #2; release it before moving it back to Backlog\.$/);
});

test('a task held by an ended session cannot go back to Backlog; the refusal says what will happen', () => {
  const ctx = ctxWith({
    tasks: [{ id: 1, assignee: 'a2' }, { id: 2, assignee: 'gone-agent', assigneeName: 'Cobalt' }, { id: 3, assignee: 'gone-agent' }],
  });
  endAgent(ctx.reg, 'a2', ctx.now);
  const after = 'it is released automatically after 24 h without activity, or the human can ask you to take it over.';
  assert.equal(errorOf(() => updateTask(ctx, { id: 1, approved: false })).message, `#1 is held by Jade, whose session has ended; ${after}`);
  assert.equal(errorOf(() => updateTask(ctx, { id: 2, approved: false })).message, `#2 is held by Cobalt, whose session has ended; ${after}`);
  assert.equal(errorOf(() => updateTask(ctx, { id: 3, approved: false })).message, `#3 is held by a session that has ended; ${after}`);
  const slow = ctxWith({ tasks: [{ id: 3, assignee: 'gone-agent' }], cfg: { ...DEFAULTS, claimTimeoutHours: 72 } });
  assert.match(errorOf(() => updateTask(slow, { id: 3, approved: false })).message, /released automatically after 72 h without activity/);
});

test('text fields are redacted', () => {
  const ctx = ctxWith();
  const secret = 'gh' + 'p_' + 'Z'.repeat(36);
  const out = apply(ctx, createTask(ctx, { title: 'Rotate key', description: `old ${secret}`, requestedByHuman: true }));
  assert.equal(ctx.state.tasks[out.result.id].description, 'old [REDACTED]');
});

/** The error a function throws (fails the test when it does not throw). */
function errorOf(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return assert.fail('expected an error');
}

test('creation records display names: the suggesting agent, or the agent that relayed the human', () => {
  const ctx = ctxWith();
  const suggested = apply(ctx, createTask(ctx, { title: 'Cache photos' }));
  const s = ctx.state.tasks[suggested.result.id];
  assert.deepEqual([s.createdBy, s.createdByName, s.requestedVia, s.requestedViaName], ['a1', 'Amber', null, null]);
  const jade = { ...ctx, agentId: 'a2' };
  const asked = apply(jade, createTask(jade, { title: 'Sign in with Google', requestedByHuman: true }));
  const h = ctx.state.tasks[asked.result.id];
  assert.deepEqual([h.origin, h.createdBy, h.createdByName, h.requestedVia, h.requestedViaName], ['human', 'human', null, 'a2', 'Jade']);
});

test('operations act only for a registered agent whose session has not ended', () => {
  const ctx = ctxWith({ tasks: [{ id: 1 }] });
  const notYet = /^BoardError: Your session is not registered on the board yet; try again\.$/;
  for (const agentId of ['unregistered', '', '__proto__', 'toString']) {
    const stranger = { ...ctx, agentId };
    assert.throws(() => createTask(stranger, { title: 'X' }), notYet, agentId);
    assert.throws(() => updateTask(stranger, { id: 1, title: 'X' }), notYet, agentId);
  }
  endAgent(ctx.reg, 'a1', ctx.now);
  assert.throws(() => createTask(ctx, { title: 'X' }), notYet);
  assert.throws(() => updateTask(ctx, { id: 1, rank: 2 }), notYet);
});

test('approval fails closed: only agentTasksNeedApproval: false lets suggestions skip Backlog', () => {
  for (const cfg of [DEFAULTS, { ...DEFAULTS, agentTasksNeedApproval: undefined }, { ...DEFAULTS, agentTasksNeedApproval: 0 }, {}, undefined]) {
    const ctx = ctxWith();
    ctx.cfg = /** @type {any} */ (cfg);
    assert.equal(createTask(ctx, { title: 'T' }).result.approved, false, JSON.stringify(cfg));
    assert.equal(createTask(ctx, { title: 'T', requestedByHuman: true }).result.approved, true);
  }
  const open = ctxWith({ cfg: { ...DEFAULTS, agentTasksNeedApproval: false } });
  assert.equal(createTask(open, { title: 'T' }).result.approved, true);
});

test('approval: a no-op when unchanged; refused for epics, done tasks and values other than true or false', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, kind: 'epic' }, { id: 2 }, { id: 3, done: true }, { id: 4, done: true, approved: false },
      { id: 5, approved: false, origin: 'agent' },
    ],
  });
  assert.deepEqual(updateTask(ctx, { id: 2, approved: true }), { events: [], result: { id: 2, unchanged: true } });
  assert.deepEqual(updateTask(ctx, { id: 1, approved: true }), { events: [], result: { id: 1, unchanged: true } });
  assert.throws(() => updateTask(ctx, { id: 1, approved: false }), /^BoardError: Epics are always approved; approve the tasks inside it\.$/);
  assert.throws(() => updateTask(ctx, { id: 3, approved: false }), /^BoardError: #3 is done; its approval no longer changes\.$/);
  assert.throws(() => updateTask(ctx, { id: 4, approved: true }), /#4 is done/);
  assert.deepEqual(updateTask(ctx, { id: 3, approved: true }).result, { id: 3, unchanged: true });
  for (const approved of ['true', 1, 0, [], {}]) {
    assert.throws(() => updateTask(ctx, { id: 5, approved }), /^BoardError: approved must be true or false \(got /, JSON.stringify(approved));
  }
  assert.throws(() => updateTask(ctx, { id: 5, approved: null }), /Nothing to update/);
  const out = apply(ctx, updateTask(ctx, { id: 5, approved: true }));
  assert.deepEqual(out.events.map((e) => e.type), ['task.approved']);
  assert.equal(ctx.state.tasks[5].approved, true);
});

test('unchanged fields are dropped; an update that changes nothing emits nothing', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, kind: 'epic', title: 'Search' },
      {
        id: 2, title: 'Same', description: 'Keep', parent: 1, labels: ['bug'], dependsOn: [3], rank: 7,
        links: [{ title: 'Plan', target: 'docs/plan.md' }],
      },
      { id: 3 },
    ],
  });
  const unchanged = { events: [], result: { id: 2, unchanged: true } };
  for (const input of [
    { title: '  Same ' }, { description: 'Keep\n' }, { parent: 1 }, { labels: ['BUG', ' bug'] }, { rank: 7 },
    { links: [{ title: 'Plan', target: 'docs/plan.md' }] }, { addDependsOn: [3] }, { removeDependsOn: [99] },
    { addDependsOn: [], removeDependsOn: [] }, { removeDependsOn: [3], addDependsOn: [3] }, { approved: true },
  ]) assert.deepEqual(updateTask(ctx, { id: 2, ...input }), unchanged, JSON.stringify(input));
  const out = updateTask(ctx, { id: 2, title: 'Same', rank: 8, labels: ['bug'] });
  assert.deepEqual(out.events, [{ type: 'task.updated', actor: 'a1', data: { id: 2, changes: { rank: 8 } } }]);
  assert.deepEqual(out.result, { id: 2 });
});

test('null means "not provided", except for parent, where it detaches the task', () => {
  const ctx = ctxWith({
    tasks: [{ id: 1, kind: 'epic' }, { id: 2, parent: 1, description: 'Keep', labels: ['bug'], links: [{ title: 'Plan', target: 'docs/plan.md' }] }],
  });
  const t = createTask(ctx, {
    title: 'T', description: null, kind: null, parent: null, dependsOn: null, labels: null, requestedByHuman: null,
  }).events[0].data.task;
  assert.deepEqual([t.kind, t.description, t.parent, t.dependsOn, t.labels, t.origin], ['task', '', null, [], [], 'agent']);
  const out = apply(ctx, updateTask(ctx, {
    id: 2, title: null, description: null, labels: null, links: null, rank: null, addDependsOn: null, removeDependsOn: null,
    approved: null, parent: null,
  }));
  assert.deepEqual(out.events.map((e) => e.data.changes), [{ parent: null }]);
  const t2 = ctx.state.tasks[2];
  assert.deepEqual([t2.parent, t2.description, t2.labels, t2.links.length], [null, 'Keep', ['bug'], 1]);
  assert.deepEqual(updateTask(ctx, { id: 2, parent: null }).result, { id: 2, unchanged: true });
  apply(ctx, updateTask(ctx, { id: 2, description: '' })); // an empty text clears on purpose
  assert.equal(ctx.state.tasks[2].description, '');
});

test('a task depends on at most 50 tasks', () => {
  const ids = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const ctx = ctxWith({ tasks: [...ids(1, 60).map((id) => ({ id })), { id: 61, dependsOn: ids(1, 49) }, { id: 62, dependsOn: ids(1, 55) }] });
  const limit = /^BoardError: A task can depend on at most 50 tasks; group work under an epic instead\.$/;
  assert.equal(createTask(ctx, { title: 'T', dependsOn: ids(1, 50) }).events[0].data.task.dependsOn.length, 50);
  assert.equal(createTask(ctx, { title: 'T', dependsOn: [...ids(1, 50), 1, 2] }).events[0].data.task.dependsOn.length, 50); // repeats count once
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: ids(1, 51) }), limit);
  assert.throws(() => createTask(ctx, { title: 'T', dependsOn: Array(2_000_000).fill(1) }), limit); // refused before looking at entries
  assert.throws(() => updateTask(ctx, { id: 61, addDependsOn: [50, 51] }), limit);
  assert.throws(() => updateTask(ctx, { id: 61, addDependsOn: ids(1, 2000) }), limit);
  assert.equal(updateTask(ctx, { id: 61, addDependsOn: [50] }).events[0].data.changes.dependsOn.length, 50);
  assert.equal(updateTask(ctx, { id: 61, removeDependsOn: [1], addDependsOn: [50, 51] }).events[0].data.changes.dependsOn.length, 50);
  // a task already above the limit (older data) can still shed dependencies, but not gain any
  assert.equal(updateTask(ctx, { id: 62, removeDependsOn: [1] }).events[0].data.changes.dependsOn.length, 54);
  assert.throws(() => updateTask(ctx, { id: 62, removeDependsOn: [1], addDependsOn: [56] }), limit);
});

test('a new dependency that closes a cycle is refused, naming the path', () => {
  // #1 depends on #2, #2 on #3; #4 is free; #5 is an epic
  const ctx = ctxWith({ tasks: [{ id: 1, dependsOn: [2] }, { id: 2, dependsOn: [3] }, { id: 3 }, { id: 4 }, { id: 5, kind: 'epic' }] });
  assert.throws(
    () => updateTask(ctx, { id: 3, addDependsOn: [4, 1] }),
    /^BoardError: #3 cannot depend on #1: that would close a dependency cycle \(#3 → #1 → #2 → #3\)\.$/,
  );
  assert.throws(() => updateTask(ctx, { id: 3, addDependsOn: [3] }), /^BoardError: A task cannot depend on itself\.$/);
  assert.throws(() => updateTask(ctx, { id: 3, addDependsOn: [5] }), /#5 is an epic; depend on the tasks inside it instead/);
  assert.throws(() => updateTask(ctx, { id: 3, addDependsOn: [99] }), /#99 does not exist/);
  assert.throws(() => updateTask(ctx, { id: 5, addDependsOn: [3] }), /^BoardError: Epics cannot have dependencies; set dependsOn on the tasks inside it\.$/);
  assert.deepEqual(updateTask(ctx, { id: 5, addDependsOn: [], removeDependsOn: [] }).result, { id: 5, unchanged: true });
  apply(ctx, updateTask(ctx, { id: 4, addDependsOn: [1, 2, 3] })); // shared descendants are fine
  assert.deepEqual(ctx.state.tasks[4].dependsOn, [1, 2, 3]);
  const chain = ctxWith({ tasks: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, dependsOn: i < 11 ? [i + 2] : [] })) });
  assert.throws(() => updateTask(chain, { id: 12, addDependsOn: [1] }), /\(#12 → #1 → #2 → #3 → … → #10 → #11 → #12\)\.$/);
});

test('ids must be task numbers: checked before the lookup, echoing at most 40 characters', () => {
  const ctx = ctxWith({ tasks: [{ id: 1 }, { id: 2, kind: 'epic' }] });
  for (const id of ['1', '#1', 0, -1, 1.5, '__proto__', 'constructor', {}, [], true, 2 ** 53, NaN]) {
    assert.throws(() => updateTask(ctx, { id, title: 'x' }), /^BoardError: id must be a task number such as 12/, String(id));
  }
  assert.throws(() => updateTask(ctx, { id: '#1', title: 'x' }), /, written as a number without quotes or "#" \(got "#1"\)\.$/);
  assert.throws(() => updateTask(ctx, { id: -1, title: 'x' }), /\(got -1\)\.$/);
  assert.throws(() => updateTask(ctx, { title: 'x' }), /^BoardError: id is required: a task number such as 12\.$/);
  assert.throws(() => updateTask(ctx, JSON.parse('{"id":"__proto__","title":"x"}')), /id must be a task number such as 12 \(got "__proto__"\)/);
  assert.equal(errorOf(() => updateTask(ctx, { id: 'A'.repeat(100_000) })).message, `id must be a task number such as 12 (got "${'A'.repeat(40)}…").`);
  const token = 'gh' + 'p_' + 'Z'.repeat(36);
  assert.equal(errorOf(() => updateTask(ctx, { id: token })).message, 'id must be a task number such as 12 (got "[REDACTED]").');
  assert.equal(errorOf(() => updateTask(ctx, { id: 'a\n\u202eb' })).message, 'id must be a task number such as 12 (got "a b").');
  assert.throws(() => updateTask(ctx, { id: 99, title: 'x' }), /^BoardError: #99 does not exist\. list_tasks shows the task numbers\.$/);
  for (const parent of ['2', 0, -3, '__proto__', 1.5, [2]]) {
    assert.throws(() => createTask(ctx, { title: 'T', parent }), /^BoardError: parent must be a task number such as 12/, String(parent));
  }
  for (const d of ['1', 0, -1, 1.5, null, '__proto__']) {
    assert.throws(() => createTask(ctx, { title: 'T', dependsOn: [d] }), /^BoardError: dependsOn must be a list of task numbers/, String(d));
  }
  assert.throws(() => updateTask(ctx, { id: 1, removeDependsOn: 'all' }), /removeDependsOn must be a list of task numbers/);
});

test('parent changes are validated on update too', () => {
  const ctx = ctxWith({
    tasks: [{ id: 1, kind: 'epic' }, { id: 2, kind: 'epic', parent: 1 }, { id: 3, kind: 'epic' }, { id: 4, parent: 2 }, { id: 5 }],
  });
  assert.throws(() => updateTask(ctx, { id: 4, parent: 5 }), /^BoardError: #5 is not an epic; only epics contain tasks — use dependsOn for order\.$/);
  assert.throws(() => updateTask(ctx, { id: 4, parent: 4 }), /^BoardError: A task cannot be its own parent\.$/);
  assert.throws(() => updateTask(ctx, { id: 1, parent: 1 }), /A task cannot be its own parent/);
  assert.throws(() => updateTask(ctx, { id: 4, parent: 99 }), /#99 does not exist/);
  assert.throws(() => updateTask(ctx, { id: 4, parent: '1' }), /parent must be a task number/);
  assert.throws(() => updateTask(ctx, { id: 3, parent: 2 }), /^BoardError: #2 is a sub-epic, and epics nest one level only; choose a top-level epic as the parent\.$/);
  assert.throws(() => updateTask(ctx, { id: 1, parent: 2 }), /#2 is a sub-epic/); // under its own sub-epic
  assert.throws(() => updateTask(ctx, { id: 1, parent: 3 }), /^BoardError: #1 has sub-epics, so it cannot become a sub-epic; move its sub-epics out first\.$/);
  apply(ctx, updateTask(ctx, { id: 4, parent: 3 })); // a task moves to an epic at any level
  apply(ctx, updateTask(ctx, { id: 2, parent: 3 })); // a sub-epic moves to another top-level epic
  assert.deepEqual([ctx.state.tasks[4].parent, ctx.state.tasks[2].parent], [3, 3]);
  apply(ctx, updateTask(ctx, { id: 2, parent: null }));
  assert.equal(ctx.state.tasks[2].parent, null);
  apply(ctx, updateTask(ctx, { id: 2, parent: 1 }));
  assert.equal(ctx.state.tasks[2].parent, 1);
});

test('rank must be a finite number', () => {
  const ctx = ctxWith({ tasks: [{ id: 1 }] });
  for (const rank of ['1', NaN, Infinity, -Infinity, [], {}, true]) {
    assert.throws(() => updateTask(ctx, { id: 1, rank }), /^BoardError: rank must be a number \(got /, String(rank));
  }
  assert.deepEqual(updateTask(ctx, { id: 1, rank: -2.5 }).events[0].data.changes, { rank: -2.5 });
});

test("messageEvent carries the author's name; extra adds only its fixed list of fields", () => {
  const ctx = ctxWith({ tasks: [{ id: 1 }, { id: 7 }] });
  const plain = messageEvent(ctx, 1, 'question', 'See #7 and #99.');
  assert.deepEqual(plain.data.message, {
    to: null, replyTo: null, relayedFromHuman: false, mentions: [7], taskId: 1, author: 'a1', authorName: 'Amber', kind: 'question',
    text: 'See #7 and #99.',
  });
  const ev = messageEvent(ctx, 1, 'question', 'See #7 and #99.', {
    to: 'human', replyTo: 'm3', relayedFromHuman: true, mentions: [5], about: 'unblocked', closesQuestions: true, // allowed
    taskId: 99, author: 'a2', authorName: 'Jade', kind: 'answer', text: 'forged', id: 'm1', at: 0, polluted: 1, // dropped
  });
  assert.deepEqual(ev, {
    type: 'message.posted',
    actor: 'a1',
    data: {
      message: {
        to: 'human', replyTo: 'm3', relayedFromHuman: true, mentions: [5], about: 'unblocked', closesQuestions: true,
        taskId: 1, author: 'a1', authorName: 'Amber', kind: 'question', text: 'See #7 and #99.',
      },
    },
  });
  assert.deepEqual(messageEvent(ctx, 1, 'comment', 'x', { to: undefined }).data.message.to, null);
  apply(ctx, { events: [ev] });
  assert.equal(ctx.state.messages[0].authorName, 'Amber');
  assert.equal(messageEvent({ ...ctx, agentId: 'unregistered' }, 1, 'comment', 'Hi').data.message.authorName, null);
});
