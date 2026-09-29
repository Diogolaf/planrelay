import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endAgent, nameOf } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { maintenance } from '../../src/core/maintenance.js';
import { BoardError, claimTask, completeTask, createTask, postMessage, releaseTask } from '../../src/core/ops.js';
import { boardCounts, listTasks, getTask, whatsNew, needsHuman } from '../../src/core/queries.js';
import { ctxWith, apply } from './ops-helpers.js';
import { T0, HOUR } from '../helpers.js';

/** assert.throws with a BoardError whose message matches. */
const refuses = (fn, re, label) => assert.throws(fn, (e) => e instanceof BoardError && re.test(e.message), label);

function sample() {
  return ctxWith({
    tasks: [
      { id: 10, kind: 'epic', title: 'Search' },
      { id: 11, kind: 'epic', title: 'Filters', parent: 10 },
      { id: 1, title: 'Vegetarian filter', parent: 11, labels: ['bug'] },
      { id: 2, title: 'Search by ingredient', parent: 10, done: true },
      { id: 3, title: 'Password reset', assignee: 'a1' },
      { id: 4, title: 'Cache photos', approved: false, origin: 'agent', createdBy: 'a2' },
    ],
  });
}

test('boardCounts counts columns and agent suggestions', () => {
  assert.deepEqual(boardCounts(sample().state), { backlog: 1, ready: 1, in_progress: 1, blocked: 0, done: 1, suggested: 1 });
});

test('listTasks filters and sorts by column then rank', () => {
  const { state, reg } = sample();
  const ids = (f) => listTasks(state, reg, f).items.map((i) => i.id);
  assert.deepEqual(ids({}), [4, 1, 3, 2]);
  assert.deepEqual(ids({ column: 'ready' }), [1]);
  assert.deepEqual(ids({ label: 'BUG' }), [1]);
  assert.deepEqual(ids({ text: 'password' }), [3]);
  assert.deepEqual(ids({ text: '#2' }), [2]);
  assert.deepEqual(ids({ epic: 10 }), [1, 2]);
  assert.deepEqual(ids({ kind: 'epic' }), [10, 11]);
  assert.deepEqual(ids({ changedSince: 0 }), [4, 1, 3, 2]);
  assert.deepEqual(ids({ changedSince: Number.MAX_SAFE_INTEGER }), []);
  const page = listTasks(state, reg, { limit: 1 });
  assert.equal(page.total, 4);
  assert.equal(page.items.length, 1);
  const item = listTasks(state, reg, { text: 'password' }).items[0];
  assert.deepEqual(item, { id: 3, title: 'Password reset', column: 'in_progress', epic: '', labels: [], assignee: 'Amber', suggested: false, progress: null });
  assert.deepEqual(listTasks(state, reg, { kind: 'epic' }).items[0].progress, { done: 1, total: 2 });
});

test('getTask adds column, blockers, blocks, epic path, children and named messages', () => {
  const ctx = ctxWith({ tasks: [{ id: 5, kind: 'epic', title: 'E' }, { id: 1, parent: 5, dependsOn: [2], assignee: 'a1' }, { id: 2 }] });
  const t = getTask(ctx.state, ctx.reg, 1, [{ id: 'm1', author: 'a2', kind: 'comment', text: 'hi' }]);
  assert.equal(t.column, 'blocked');
  assert.deepEqual(t.blockers, [{ type: 'dependency', id: 2 }]);
  assert.equal(t.epicPath, 'E');
  assert.equal(t.assigneeName, 'Amber');
  assert.equal(t.messages[0].authorName, 'Jade');
  assert.deepEqual(getTask(ctx.state, ctx.reg, 2, []).blocks, [1]);
  const epic = getTask(ctx.state, ctx.reg, 5, []);
  assert.deepEqual(epic.progress, { done: 0, total: 1 });
  assert.deepEqual(epic.children, [1]);
  assert.equal(getTask(ctx.state, ctx.reg, 99, []), null);
});

test("whatsNew brings only what needs this agent's attention", () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a1' }, { id: 2, assignee: 'a2' }, { id: 3 }] });
  const as = (agentId) => ({ ...ctx, agentId });
  apply(ctx, postMessage(as('a1'), { taskId: 1, kind: 'question', to: 'a2', text: 'Which endpoint?' }));
  const qid = ctx.state.tasks[1].openQuestions[0].id;
  apply(ctx, postMessage(as('a2'), { taskId: 1, kind: 'answer', replyTo: qid, text: '/search' }));
  apply(ctx, postMessage(as('a2'), { taskId: 3, kind: 'comment', text: 'Relates to #1.' }));
  apply(ctx, postMessage(as('a2'), { taskId: 3, kind: 'comment', text: 'Unrelated.' }));
  apply(ctx, postMessage(as('a1'), { taskId: 1, kind: 'comment', text: 'My own note.' }));
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', ctx.now - 1).map((i) => i.reason), ['answer', 'mention']);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', ctx.now - 1).map((i) => i.reason), ['question']);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', ctx.now), []);
  assert.equal(whatsNew(ctx.state, ctx.reg, 'a1', ctx.now - 1)[0].authorName, 'Jade');
});

test('whatsNew reports the claimed task being unblocked', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a2' }, { id: 2, assignee: 'a1', dependsOn: [1] }] });
  apply(ctx, completeTask({ ...ctx, agentId: 'a2' }, { id: 1, summary: 'Shipped.' }));
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', ctx.now - 1).map((i) => i.reason), ['unblocked']);
});

test('needsHuman lists questions to the human, agent suggestions and stalled claims', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, openQuestions: [{ id: 'm1', to: 'human', author: 'a1', at: T0, text: 'Oven time?' }] },
      { id: 2, approved: false, origin: 'agent', createdBy: 'a2', title: 'Cache photos' },
      { id: 3, approved: false, origin: 'human' },
      { id: 4, assignee: 'a2', claim: { folder: '/w/b', since: T0 } },
    ],
  });
  endAgent(ctx.reg, 'a2', T0);
  const n = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0 + HOUR);
  assert.deepEqual(n.questions.map((q) => [q.taskId, q.askedBy, q.question.id]), [[1, 'Amber', 'm1']]);
  assert.deepEqual(n.approvals, [{ id: 2, title: 'Cache photos', suggestedBy: 'Jade' }]);
  assert.deepEqual(n.stalled.map((s) => [s.id, s.releaseAt]), [[4, T0 + 24 * HOUR]]);
});

test('names written with events stay right after the registry forgets the agent; nameOf is only the fallback', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, title: 'Vegetarian filter' },
      { id: 2, title: 'Password reset', assignee: 'a1' },
      { id: 3, title: 'Search by ingredient' },
      { id: 4, title: 'Cache photos', assignee: 'old-session', assigneeName: 'Cobalt' },
      { id: 5, title: 'Share a recipe', assignee: 'older-session' },
    ],
  });
  const jade = { ...ctx, agentId: 'a2' };
  apply(ctx, createTask(jade, { title: 'Offline mode' })); // #6, Jade's suggestion
  apply(ctx, claimTask(jade, { id: 3 }));
  apply(ctx, completeTask(jade, { id: 3, summary: 'Shipped.' }));
  apply(ctx, claimTask(jade, { id: 1 }));
  apply(ctx, postMessage(jade, { taskId: 1, kind: 'question', to: 'human', text: 'Metric or imperial?' }));
  apply(ctx, postMessage(jade, { taskId: 2, text: 'The login screen changed; see #1.' }));
  apply(ctx, releaseTask(jade, { id: 1, note: 'Waiting on the human for units.' }));
  delete ctx.reg.agents.a2; // housekeeping prunes an agent 7 days after its session ended, once it holds no claim
  assert.equal(nameOf(ctx.reg, 'a2'), 'an earlier agent');

  const n = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0);
  assert.deepEqual(n.questions.map((q) => [q.taskId, q.askedBy]), [[1, 'Jade']]);
  assert.deepEqual(n.approvals, [{ id: 6, title: 'Offline mode', suggestedBy: 'Jade' }]);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', T0 - 1).map((i) => [i.reason, i.message.taskId, i.authorName]), [['update', 2, 'Jade']]);
  const done = getTask(ctx.state, ctx.reg, 3, []);
  assert.deepEqual([done.completedBy, done.completedByName], ['a2', 'Jade']);
  assert.equal(getTask(ctx.state, ctx.reg, 6, []).createdByName, 'Jade');
  const onOne = ctx.state.messages.filter((m) => m.taskId === 1);
  assert.deepEqual(getTask(ctx.state, ctx.reg, 1, onOne).messages.map((m) => [m.kind, m.authorName]), [['question', 'Jade'], ['handoff', 'Jade']]);
  // a holder the registry no longer knows keeps the name stored with its claim
  assert.equal(listTasks(ctx.state, ctx.reg, { text: '#4' }).items[0].assignee, 'Cobalt');
  assert.equal(getTask(ctx.state, ctx.reg, 4, []).assigneeName, 'Cobalt');
  // with no name stored anywhere, nameOf's fallback
  assert.equal(getTask(ctx.state, ctx.reg, 5, []).assigneeName, 'an earlier agent');
  assert.equal(getTask(ctx.state, ctx.reg, 1, [{ id: 'm9', author: 'a2', kind: 'comment', text: 'x' }]).messages[0].authorName, 'an earlier agent');
});

test("a holder shows under its current name, which other agents address it by; what it wrote keeps the name it had then", () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }] });
  apply(ctx, claimTask(ctx, { id: 1 }));
  apply(ctx, postMessage(ctx, { taskId: 1, text: 'Started with the recipe model.' }));
  // Amber's session ended, a new session took "Amber", and she came back renamed (§4)
  ctx.reg.agents.a1.name = 'Cobalt';
  assert.equal(ctx.state.tasks[1].assigneeName, 'Amber'); // as stored with the claim
  assert.equal(listTasks(ctx.state, ctx.reg, {}).items[0].assignee, 'Cobalt');
  const t = getTask(ctx.state, ctx.reg, 1, ctx.state.messages);
  assert.equal(t.assigneeName, 'Cobalt');
  assert.equal(t.messages[0].authorName, 'Amber');
});

test('list filters come from tool arguments: a bad one is refused with guidance', () => {
  const { state, reg } = sample();
  const bad = (f, re) => refuses(() => listTasks(state, reg, f), re, JSON.stringify(f));
  bad({ text: 5 }, /^text must be text \(got 5\)\.$/);
  bad({ text: ['password'] }, /^text must be text \(got a list\)\.$/);
  bad({ label: { name: 'bug' } }, /^label must be text, such as "bug" \(got an object\)\.$/);
  bad({ label: true }, /^label must be text, such as "bug" \(got true\)\.$/);
  bad({ epic: 10.5 }, /^epic must be a task number such as 12 \(got 10\.5\)\.$/);
  bad({ epic: '#10' }, /^epic must be a task number such as 12, written as a number without quotes or "#" \(got "#10"\)\.$/);
  bad({ epic: -1 }, /^epic must be a task number such as 12 \(got -1\)\.$/);
  bad({ epic: 1 }, /^#1 is not an epic; list_tasks with kind "epic" shows the epics\.$/);
  bad({ epic: 99 }, /^#99 does not exist; list_tasks with kind "epic" shows the epics\.$/);
  bad({ column: 'todo' }, /^column must be one of backlog, ready, in_progress, blocked, done \(got "todo"\)\.$/);
  bad({ column: 'Ready' }, /^column must be one of .* \(got "Ready"\)\.$/);
  bad({ column: 3 }, /^column must be one of .* \(got 3\)\.$/);
  bad({ kind: 'story' }, /^kind must be "task" or "epic" \(got "story"\)\.$/);
  bad({ kind: ['epic'] }, /^kind must be "task" or "epic" \(got a list\)\.$/);
  bad({ changedSince: 'yesterday' }, /^changedSince must be a Unix time in milliseconds \(got "yesterday"\)\.$/);
  bad({ changedSince: Number.NaN }, /^changedSince must be a Unix time in milliseconds \(got NaN\)\.$/);
  bad({ colum: 'ready' }, /^Unknown field "colum"; allowed: column, epic, label, text, kind, changedSince, limit\.$/);
  bad({ Column: 'ready' }, /^Unknown field "Column" \(did you mean column\?\)/);
  bad(JSON.parse('{"__proto__": {"column": "ready"}}'), /^Unknown field "__proto__"/);
  bad('ready', /^The input must be an object of named fields\.$/);
  bad(['ready'], /^The input must be an object of named fields\.$/);
  // a long bad value is quoted short, on one line
  refuses(() => listTasks(state, reg, { column: `todo\n${'x'.repeat(5000)}` }), /^column must be one of [^\n]{0,150}$/);
});

test('null means not provided; limit is clamped to 1-200, and anything but a number means the default of 50', () => {
  const ctx = ctxWith({ tasks: Array.from({ length: 250 }, (_, i) => ({ id: i + 1, title: `Recipe ${i + 1}` })) });
  const shown = (limit) => listTasks(ctx.state, ctx.reg, { limit }).items.length;
  assert.equal(shown(undefined), 50);
  assert.equal(shown(null), 50);
  assert.equal(shown(-5), 1);
  assert.equal(shown(0), 1);
  assert.equal(shown(2.9), 2);
  assert.equal(shown(1e9), 200);
  assert.equal(shown(Number.POSITIVE_INFINITY), 200);
  assert.equal(shown(Number.NEGATIVE_INFINITY), 1);
  assert.equal(shown(Number.NaN), 50);
  assert.equal(shown('10'), 50);
  assert.equal(shown({}), 50);
  assert.equal(listTasks(ctx.state, ctx.reg, { limit: 1e9 }).total, 250);
  const nulls = { column: null, epic: null, label: null, text: null, kind: null, changedSince: null, limit: null };
  assert.equal(listTasks(ctx.state, ctx.reg, nulls).total, 250);
  assert.equal(listTasks(ctx.state, ctx.reg).total, 250);
  assert.equal(listTasks(ctx.state, ctx.reg, null).total, 250);
  // empty or blank text and label filter nothing
  assert.equal(listTasks(ctx.state, ctx.reg, { text: '  ', label: '' }).total, 250);
});

test('label and text filters are forgiving about case and spacing', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, title: 'Vegetarian filter', labels: ['good first issue'] },
      { id: 2, title: 'Password reset', description: 'Send a reset link by e-mail.' },
      { id: 12, title: 'Search' },
    ],
  });
  const ids = (f) => listTasks(ctx.state, ctx.reg, f).items.map((i) => i.id);
  assert.deepEqual(ids({ label: '  Good  First\tISSUE ' }), [1]);
  assert.deepEqual(ids({ text: ' RESET LINK ' }), [2]);
  assert.deepEqual(ids({ text: '12' }), [12]); // a number finds the id, not titles that contain it
  assert.deepEqual(ids({ text: '# 12' }), []);
});

test('getTask checks the id, and returns a copy holding only the task fields', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', labels: ['bug'], dependsOn: [2], done: true, checklist: [{ text: 'API', done: true }] }, { id: 2 }] });
  const { state, reg } = ctx;
  refuses(() => getTask(state, reg, '1', []), /^id must be a task number such as 12, written as a number without quotes or "#" \(got "1"\)\.$/);
  refuses(() => getTask(state, reg, 0, []), /^id must be a task number such as 12 \(got 0\)\.$/);
  refuses(() => getTask(state, reg, 1.5, []), /^id must be a task number such as 12 \(got 1\.5\)\.$/);
  refuses(() => getTask(state, reg, '__proto__', []), /^id must be a task number such as 12 \(got "__proto__"\)\.$/);
  refuses(() => getTask(state, reg, undefined, []), /^id is required: a task number such as 12\.$/);
  assert.equal(getTask(state, reg, 3, []), null);
  // Done beats Blocked: a done task shows no blockers, even with a dependency still open
  const t = getTask(state, reg, 1, []);
  assert.equal(t.column, 'done');
  assert.deepEqual(t.blockers, []);
  // a copy: changing the view never changes the board
  t.labels.push('x');
  t.dependsOn.length = 0;
  t.checklist[0].done = false;
  assert.deepEqual(state.tasks[1].labels, ['bug']);
  assert.deepEqual(state.tasks[1].dependsOn, [2]);
  assert.equal(state.tasks[1].checklist[0].done, true);
  // only the task's own fields: anything else a hand-edited snapshot holds stays out
  /** @type {any} */ (state.tasks[2]).internalNote = 'kept out';
  const view = getTask(state, reg, 2, undefined);
  assert.equal(Object.hasOwn(view, 'internalNote'), false);
  assert.deepEqual(view.messages, []);
  assert.deepEqual(Object.keys(view).filter((k) => !Object.hasOwn(state.tasks[2], k)).sort(), [
    'blockers', 'blocks', 'children', 'column', 'epicPath', 'messages', 'progress',
  ]);
});

test("getTask's messages keep the message fields only and skip anything that is not a message", () => {
  const ctx = ctxWith({ tasks: [{ id: 1 }] });
  const line = { id: 'm4', taskId: 1, author: 'a2', authorName: 'Jade', kind: 'question', to: 'human', replyTo: null, relayedFromHuman: false, mentions: [], about: null, at: T0, text: 'Oven time?' };
  const messages = [null, 5, 'm1', ['m2'], { ...line, closesQuestions: true, extra: 'x' }, { ...line, id: 'm5', authorName: 'J'.repeat(61) }];
  const view = getTask(ctx.state, ctx.reg, 1, messages).messages;
  assert.deepEqual(view, [line, { ...line, id: 'm5', authorName: 'Jade' }]); // an unusable stored name falls back to the registry
  assert.deepEqual(getTask(ctx.state, ctx.reg, 1, 'm1').messages, []);
});

test('whatsNew pings notes addressed to the agent, and never its own actions', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }, { id: 2, title: 'Password reset' }] });
  const amber = ctx;
  const jade = { ...ctx, agentId: 'a2' };
  apply(ctx, claimTask(jade, { id: 2 }));
  endAgent(ctx.reg, 'a2', T0); // Jade's session ends; her claim stays with the folder
  apply(ctx, claimTask(amber, { id: 2, takeOver: true })); // the human asked Amber to resume #2
  apply(ctx, postMessage(amber, { taskId: 2, kind: 'question', text: 'Which hash function?' }));
  // the takeover note on Amber's new task is addressed to Jade: it is for Jade alone
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', T0 - 1), []);
  apply(ctx, completeTask(amber, { id: 2, summary: 'Shipped.' })); // closes Amber's own question
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', T0 - 1), []);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', T0 - 1).map((i) => [i.reason, i.message.taskId, i.authorName, i.message.text]), [
    ['update', 2, 'system', 'Amber took over from Jade, whose session had ended (folder /w/b).'],
  ]);
  // Amber releases the claim of Jade, who is gone again: the note reaches Jade although #1 is no longer hers
  const again = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }] });
  apply(again, claimTask({ ...again, agentId: 'a2' }, { id: 1 }));
  endAgent(again.reg, 'a2', T0);
  apply(again, releaseTask(again, { id: 1, note: 'Nobody is on it; back to Ready.' }));
  assert.deepEqual(whatsNew(again.state, again.reg, 'a2', T0 - 1).map((i) => [i.reason, i.message.text]), [
    ['update', "Amber released Jade's claim, whose session had ended."],
  ]);
  assert.deepEqual(whatsNew(again.state, again.reg, 'a1', T0 - 1), []);
});

test('whatsNew needs an agent id, and a since that is not a number means from the start', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a1' }, { id: 2 }] });
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 1, text: 'Heads up: the API changed.' }));
  // without the check, a missing id would match #2 as "its" task, since #2 has no assignee either
  for (const who of [null, undefined, '', 5]) assert.deepEqual(whatsNew(ctx.state, ctx.reg, who, 0), [], String(who));
  const hostile = { valueOf: () => T0 + HOUR }; // never used as a number
  for (const since of [Number.NaN, undefined, null, 'yesterday', hostile]) {
    assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', since).map((i) => i.reason), ['update'], String(since));
  }
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', Number.POSITIVE_INFINITY), []);
});

test('the stalled countdown ends exactly when housekeeping releases the claim', () => {
  const ctx = ctxWith({ tasks: [{ id: 4, title: 'Cache photos', assignee: 'a2', claim: { folder: '/w/b', since: T0 } }] });
  ctx.reg.activity[4] = T0 + 2 * HOUR; // an edit on the task, recorded by the hook
  endAgent(ctx.reg, 'a2', T0 + 2 * HOUR);
  const [s] = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0 + 3 * HOUR).stalled;
  assert.deepEqual(s, { id: 4, title: 'Cache photos', since: T0 + 2 * HOUR, releaseAt: T0 + 26 * HOUR });
  const io = { host: 'test-host', missing: () => false, alive: () => true };
  const released = (now) => maintenance(ctx.state, structuredClone(ctx.reg), DEFAULTS, now, io).some((e) => e.type === 'task.released');
  assert.equal(released(s.releaseAt), false);
  assert.equal(released(s.releaseAt + 1), true);
});

test('queries never change the board, and their results share nothing with it', () => {
  const ctx = sample();
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 1, kind: 'question', to: 'human', text: 'Include vegan? See #3.' }));
  const before = structuredClone({ state: ctx.state, reg: ctx.reg });
  boardCounts(ctx.state);
  const list = listTasks(ctx.state, ctx.reg, { label: 'bug' });
  listTasks(ctx.state, ctx.reg, { kind: 'epic', epic: 10 });
  for (const id of [2, 3, 4, 10, 11]) getTask(ctx.state, ctx.reg, id, ctx.state.messages);
  const view = getTask(ctx.state, ctx.reg, 1, ctx.state.messages);
  const pings = whatsNew(ctx.state, ctx.reg, 'a1', 0);
  const n = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0);
  assert.deepEqual({ state: ctx.state, reg: ctx.reg }, before);
  list.items[0].labels.push('x');
  view.messages[0].mentions.push(99);
  view.openQuestions[0].text = 'changed';
  pings[0].message.mentions.push(99);
  n.questions[0].question.text = 'changed';
  assert.deepEqual({ state: ctx.state, reg: ctx.reg }, before);
});
