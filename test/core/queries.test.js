import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endAgent, nameOf, touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { inheritClaim, maintenance } from '../../src/core/maintenance.js';
import { BoardError, claimTask, completeTask, createTask, postMessage, releaseTask, updateTask } from '../../src/core/ops.js';
import { boardCounts, listTasks, getTask, whatsNew, needsHuman } from '../../src/core/queries.js';
import { MESSAGE_RING } from '../../src/core/reduce.js';
import { ctxWith, apply } from './ops-helpers.js';
import { T0, MIN, HOUR } from '../helpers.js';

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
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: 0 }).items.map((i) => i.reason), ['answer', 'mention']);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', { afterSeq: 0 }).items.map((i) => i.reason), ['question']);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: ctx.state.seq }).items, []);
  assert.equal(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: 0 }).items[0].authorName, 'Jade');
});

test('whatsNew reports the claimed task being unblocked', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a2' }, { id: 2, assignee: 'a1', dependsOn: [1] }] });
  apply(ctx, completeTask({ ...ctx, agentId: 'a2' }, { id: 1, summary: 'Shipped.' }));
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: 0 }).items.map((i) => i.reason), ['unblocked']);
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
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', {}).items.map((i) => [i.reason, i.message.taskId, i.authorName]), [['update', 2, 'Jade']]);
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

test('a registry name that is not usable text is never shown; the name stored with the claim is', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a1', assigneeName: 'Amber' }] });
  const a1 = /** @type {any} */ (ctx.reg.agents.a1);
  a1.name = { first: 'Amber' }; // a hand-edited agents.json: the registry reader keeps the agent
  assert.equal(listTasks(ctx.state, ctx.reg, {}).items[0].assignee, 'Amber');
  a1.name = '';
  assert.equal(getTask(ctx.state, ctx.reg, 1, []).assigneeName, 'Amber');
  ctx.state.tasks[1].assigneeName = null; // nothing stored either: nameOf's fallback, which is always text
  assert.equal(getTask(ctx.state, ctx.reg, 1, []).assigneeName, 'an earlier agent');
  assert.equal(getTask(ctx.state, ctx.reg, 1, [{ id: 'm1', author: 'a1', kind: 'comment', text: 'x' }]).messages[0].authorName, 'an earlier agent');
});

test('Done lists the most recently completed first; the other columns keep rank order', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, title: 'Vegetarian filter', done: true, doneAt: T0 + HOUR, rank: 1 },
      { id: 2, title: 'Password reset', done: true, doneAt: T0 + 3 * HOUR, rank: 2 },
      { id: 3, title: 'Search by ingredient', done: true, doneAt: T0 + 2 * HOUR, rank: 3 },
      { id: 4, title: 'Cache photos', done: true, doneAt: T0 + 2 * HOUR, rank: 0 }, // same time: rank decides
      { id: 5, title: 'Share a recipe', done: true, doneAt: null, rank: -1 }, // no usable time: last
      { id: 6, title: 'Offline mode', rank: 9 },
      { id: 7, title: 'Dark theme', rank: 8 },
    ],
  });
  assert.deepEqual(listTasks(ctx.state, ctx.reg, {}).items.map((i) => i.id), [7, 6, 2, 4, 3, 1, 5]);
  assert.deepEqual(listTasks(ctx.state, ctx.reg, { column: 'done', limit: 1 }).items.map((i) => i.id), [2]);
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

test('label and text filters drop invisible characters the way ops does before storing', () => {
  /** Characters by code point, so this source holds no invisible characters (or escapes a tool could decode). */
  const ch = (...cps) => String.fromCodePoint(...cps);
  const ZWSP = ch(0x200b);
  const technologist = ch(0x1f469, 0x200d, 0x1f4bb); // woman technologist: two emoji joined by a ZWJ
  const ctx = ctxWith();
  apply(ctx, createTask(ctx, { title: 'Profile page', labels: [`${technologist} frontend`, `bug${ZWSP}`, `caf${ch(0xe9)}`] }));
  assert.deepEqual(ctx.state.tasks[1].labels, [`${ch(0x1f469, 0x1f4bb)} frontend`, 'bug', `caf${ch(0xe9)}`]); // as ops stores them
  const ids = (f) => listTasks(ctx.state, ctx.reg, f).items.map((i) => i.id);
  assert.deepEqual(ids({ label: `${technologist} frontend` }), [1]);
  assert.deepEqual(ids({ label: `bug${ZWSP}` }), [1]);
  assert.deepEqual(ids({ label: `B${ch(0xe0041)}UG` }), [1]); // a tag character, invisible
  assert.deepEqual(ids({ label: `CAFE${ch(0x301)}` }), [1]); // decomposed: an accent typed as a combining mark
  assert.deepEqual(ids({ text: `profile${ZWSP} ${ch(0x202e)}page` }), [1]); // a zero-width space and a bidi override
  assert.deepEqual(ids({ label: ZWSP }), [1]); // nothing visible: no filter
});

test('text search normalizes what it searches like the search term, so words with ZWNJ or ZWJ in a description are found as typed', () => {
  /** Characters by code point, so this source holds no invisible characters (or escapes a tool could decode). */
  const ch = (...cps) => String.fromCodePoint(...cps);
  const ZWNJ = ch(0x200c);
  const persian = `${ch(0x0645, 0x06cc)}${ZWNJ}${ch(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`; // a Persian word, written with a ZWNJ
  const technologist = ch(0x1f469, 0x200d, 0x1f4bb); // two emoji joined by a ZWJ
  const ctx = ctxWith();
  apply(ctx, createTask(ctx, { title: 'Profile page', description: `Owner: the ${technologist} team.\nNote: ${persian}` }));
  apply(ctx, createTask(ctx, { title: `Search ${persian}` }));
  const { description } = ctx.state.tasks[1];
  assert.ok(description.includes(ZWNJ) && description.includes(ch(0x200d))); // multi-line text keeps both
  const ids = (text) => listTasks(ctx.state, ctx.reg, { text }).items.map((i) => i.id);
  assert.deepEqual(ids(persian), [1, 2]); // in the description (ZWNJ kept) and in the title (ZWNJ dropped)
  assert.deepEqual(ids(technologist), [1]);
  assert.deepEqual(ids(`the ${technologist} team. note`), [1]); // across the line break
});

test('label and text filters are forgiving about case and spacing', () => {
  const ctx = ctxWith({
    tasks: [
      { id: 1, title: 'Vegetarian filter', labels: ['good first issue'] },
      { id: 2, title: 'Password reset', description: 'Send a reset link by e-mail.' },
      { id: 3, title: 'Recipe API', description: 'Keep the\n  old endpoint.' },
      { id: 12, title: 'Search' },
    ],
  });
  const ids = (f) => listTasks(ctx.state, ctx.reg, f).items.map((i) => i.id);
  assert.deepEqual(ids({ label: '  Good  First\tISSUE ' }), [1]);
  assert.deepEqual(ids({ text: ' RESET LINK ' }), [2]);
  assert.deepEqual(ids({ text: 'the old  endpoint' }), [3]); // spaces and line breaks match each other
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
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', {}).items, []);
  apply(ctx, completeTask(amber, { id: 2, summary: 'Shipped.' })); // closes Amber's own question (e2f70cf)
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', {}).items, []);
  assert.ok(ctx.state.messages.some((m) => m.author === 'system' && m.holder === 'a1' && /^Open question m\d+ was closed/.test(m.text)));
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', {}).items.map((i) => [i.reason, i.message.taskId, i.authorName, i.message.text]), [
    ['update', 2, 'system', 'Amber took over from Jade, whose session had ended (folder /w/b).'],
  ]);
  // Amber releases the claim of Jade, who is gone again: the note reaches Jade although #1 is no longer
  // hers, and so does Amber's handoff note, posted while Jade still held #1
  const again = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }] });
  apply(again, claimTask({ ...again, agentId: 'a2' }, { id: 1 }));
  endAgent(again.reg, 'a2', T0);
  apply(again, releaseTask(again, { id: 1, note: 'Nobody is on it; back to Ready.' }));
  assert.deepEqual(whatsNew(again.state, again.reg, 'a2', {}).items.map((i) => [i.reason, i.authorName, i.message.text]), [
    ['update', 'Amber', 'Nobody is on it; back to Ready.'],
    ['update', 'system', "Amber released Jade's claim, whose session had ended."],
  ]);
  assert.deepEqual(whatsNew(again.state, again.reg, 'a1', {}).items, []);
});

test('a message stamped before the reader was last shown updates, but committed after, is still pinged', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a1' }] });
  const jade = { ...ctx, agentId: 'a2' };
  apply({ ...jade, now: T0 + 5 * MIN }, postMessage(jade, { taskId: 1, text: 'The recipe model is merged.' }));
  // Amber is shown her updates at T0 + 10 min; her cursor moves to the board's sequence number
  const cursor = ctx.state.seq;
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor }).items, []);
  // Jade's next write read the clock at T0 + 7 min, then waited for the lock until after that
  apply({ ...jade, now: T0 + 7 * MIN }, postMessage(jade, { taskId: 1, text: 'The API now returns grams.' }));
  const pings = whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor }).items;
  assert.deepEqual(pings.map((i) => [i.reason, i.message.text, i.message.at]), [['update', 'The API now returns grams.', T0 + 7 * MIN]]);
  // a time cursor would have skipped it: at T0 + 10 min it was not yet on the board, and it is stamped earlier
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor, since: T0 + 10 * MIN }).items, []);
});

test('whatsNew needs an agent id; a bad afterSeq (from the registry) means 0; a bad since (a tool argument) is refused', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, assignee: 'a1' }, { id: 2 }] });
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 1, text: 'Heads up: the API changed.' }));
  // without the check, a missing id would match #2 as "its" task, since #2 has no assignee either
  for (const who of [null, undefined, '', 5]) assert.deepEqual(whatsNew(ctx.state, ctx.reg, who).items, [], String(who));
  const reasons = (opts) => whatsNew(ctx.state, ctx.reg, 'a1', opts).items.map((i) => i.reason);
  const hostile = { valueOf: () => Number.MAX_SAFE_INTEGER }; // never used as a number
  for (const afterSeq of [undefined, null, -1, 0.5, '5', Number.NaN, Number.POSITIVE_INFINITY, hostile]) {
    assert.deepEqual(reasons({ afterSeq }), ['update'], `afterSeq ${String(afterSeq)}`);
  }
  for (const since of [undefined, null]) assert.deepEqual(reasons({ since }), ['update'], `since ${String(since)}`);
  refuses(() => reasons({ since: '2026-09-30' }), /^since must be a Unix time in milliseconds \(got "2026-09-30"\)\.$/);
  refuses(() => reasons({ since: Number.NaN }), /^since must be a Unix time in milliseconds \(got NaN\)\.$/);
  refuses(() => reasons({ since: Number.POSITIVE_INFINITY }), /^since must be a Unix time in milliseconds \(got Infinity\)\.$/);
  refuses(() => reasons({ since: hostile }), /^since must be a Unix time in milliseconds \(got an object\)\.$/);
  // the same message list_tasks gives for changedSince
  refuses(() => listTasks(ctx.state, ctx.reg, { changedSince: '2026-09-30' }), /^changedSince must be a Unix time in milliseconds \(got "2026-09-30"\)\.$/);
  for (const opts of [undefined, null, 5, 'x', []]) assert.deepEqual(reasons(opts), ['update'], `options ${String(opts)}`);
  assert.deepEqual(reasons({ afterSeq: ctx.state.seq - 1 }), ['update']);
  assert.deepEqual(reasons({ afterSeq: ctx.state.seq }), []);
  assert.deepEqual(reasons({ since: T0 }), ['update']); // from that time on, inclusive
  assert.deepEqual(reasons({ since: T0 + 1 }), []);
});

test('a cursor ahead of the board counts as 0: the board was reset under it, so the agent sees the ring once', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a1' }] });
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 1, text: 'The recipe model is merged.' }));
  const texts = (afterSeq) => whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq }).items.map((i) => i.message.text);
  assert.deepEqual(texts(ctx.state.seq), []);
  assert.deepEqual(texts(ctx.state.seq + 1), ['The recipe model is merged.']);
  assert.deepEqual(texts(Number.MAX_SAFE_INTEGER), ['The recipe model is merged.']);
});

test('news on a task reaches the agent that held it when it was posted, even after it completes or releases the task', () => {
  for (const [end, input] of [[completeTask, { id: 1, summary: 'Shipped the filter.' }], [releaseTask, { id: 1, note: 'Stopping here.' }]]) {
    const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a1' }] });
    const jade = { ...ctx, agentId: 'a2' };
    const cursor = ctx.state.seq; // Amber's prompt: her turn starts
    apply(ctx, postMessage(jade, { taskId: 1, text: 'Heads-up: the API now returns grams.' }));
    apply(ctx, end(ctx, input)); // Amber ends her turn with the task
    const pings = whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor }).items;
    assert.deepEqual(pings.map((i) => [i.reason, i.message.text]), [['update', 'Heads-up: the API now returns grams.']], end.name);
    if (end === releaseTask) {
      // the next holder is not pinged about what was posted before its claim
      apply(ctx, claimTask({ ...ctx, agentId: 'a2' }, { id: 1 }));
      assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', { afterSeq: cursor }).items, []);
      apply(ctx, postMessage(ctx, { taskId: 1, text: 'The old endpoint can go.' }));
      assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', { afterSeq: cursor }).items.map((i) => i.message.text), ['The old endpoint can go.']);
      assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor }).items.length, 1);
    }
  }
});

test('the holder is pinged when its task no longer waits on dependencies but still has an open question (§5)', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Recipe API', assignee: 'a2' }, { id: 3, title: 'Vegetarian filter', assignee: 'a1' }] });
  const jade = { ...ctx, agentId: 'a2' };
  apply(ctx, updateTask(ctx, { id: 3, addDependsOn: [1] })); // a dependency added after Amber claimed #3
  apply(ctx, postMessage(jade, { taskId: 3, kind: 'question', to: 'human', text: 'Keep the old units?' }));
  const cursor = ctx.state.seq;
  apply(ctx, completeTask(jade, { id: 1, summary: 'Shipped.' }));
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor }).items.map((i) => [i.reason, i.message.about, i.message.text]), [
    ['update', 'dependencies-done', '#1 is done — #3 no longer waits on dependencies, but still has an open question.'],
  ]);
  // the activity feed records it as its own kind
  assert.deepEqual(ctx.state.recent.filter((a) => a.type === 'dependencies-done').map((a) => a.taskId), [3]);
});

test("getTask names every open question's asker, with the same fallback as the other names", () => {
  const ctx = ctxWith({
    tasks: [{
      id: 1,
      title: 'Vegetarian filter',
      openQuestions: [
        { id: 'm1', to: 'human', author: 'a2', at: T0, text: 'Oven time?' }, // stored before questions kept names
        { id: 'm2', to: 'any', author: 'gone-long-ago', at: T0, text: 'Which API?' },
      ],
    }, { id: 2, title: 'Password reset' }],
  });
  const view = getTask(ctx.state, ctx.reg, 1, [{ id: 'm1', author: 'a2', kind: 'question', text: 'Oven time?' }]);
  assert.deepEqual(view.openQuestions.map((q) => q.authorName), ['Jade', 'an earlier agent']);
  assert.equal(view.openQuestions[0].authorName, view.messages[0].authorName);
  // no name stored with the question, and the registry forgot the asker: the ring entry still has it
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 2, kind: 'question', to: 'human', text: 'Email or SMS?' }));
  delete ctx.state.tasks[2].openQuestions[0].authorName;
  delete ctx.reg.agents.a2;
  assert.equal(getTask(ctx.state, ctx.reg, 2, []).openQuestions[0].authorName, 'Jade');
});

test('the agent that inherits a claim is not pinged by the inherit note, which is applied before the claim', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a2', claim: { folder: '/w/b', since: T0 } }] });
  endAgent(ctx.reg, 'a2', T0);
  touchAgent(ctx.reg, { id: 'a3', folder: '/w/b', seq: 0 }, T0 + MIN); // a new session in Jade's folder
  apply(ctx, { events: inheritClaim(ctx.state, ctx.reg, 'a3', '/w/b') });
  assert.equal(ctx.state.tasks[1].assignee, 'a3');
  assert.deepEqual(ctx.state.messages.map((m) => [m.author, m.holder, m.text]), [['system', 'a2', 'Jade continues this task in a new session.']]);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a3', { afterSeq: 0 }).items, []);
  assert.deepEqual(whatsNew(ctx.state, ctx.reg, 'a2', { afterSeq: 0 }).items, []);
});

test('whatsNew says when updates after the cursor fell out of the message ring', () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter', assignee: 'a1' }, { id: 2, title: 'Password reset', assignee: 'a2' }, { id: 3, title: 'Chatter' }] });
  const jade = { ...ctx, agentId: 'a2' };
  apply(ctx, postMessage(ctx, { taskId: 1, kind: 'question', to: 'a2', text: 'Which unit?' }));
  const cursor = ctx.state.seq; // Amber was shown her updates here, then was away
  apply(ctx, postMessage(jade, { taskId: 1, kind: 'answer', replyTo: ctx.state.tasks[1].openQuestions[0].id, text: 'Grams.' }));
  const seen = () => {
    const out = whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: cursor });
    return [out.items.map((i) => i.reason), out.olderDropped];
  };
  assert.deepEqual(seen(), [['answer'], false]);
  for (let i = 0; i < MESSAGE_RING - 2; i++) apply(ctx, postMessage(jade, { taskId: 3, text: `Chatter ${i}` }));
  assert.equal(ctx.state.messages.length, MESSAGE_RING);
  assert.deepEqual(seen(), [['answer'], false]); // full, but nothing after the cursor is gone
  apply(ctx, postMessage(jade, { taskId: 3, text: 'More chatter.' })); // the question (at the cursor) falls out
  assert.deepEqual(seen(), [['answer'], false]);
  apply(ctx, postMessage(jade, { taskId: 3, text: 'Even more chatter.' })); // the answer falls out
  assert.deepEqual(seen(), [[], true]);
  assert.equal(whatsNew(ctx.state, ctx.reg, 'a1', { afterSeq: ctx.state.messages[0].seq - 1 }).olderDropped, false);
  // a ring that is not full has lost nothing, however far its first entry is past the cursor (other events in between)
  const fresh = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }] });
  apply(fresh, claimTask(fresh, { id: 1 }));
  apply(fresh, postMessage({ ...fresh, agentId: 'a2' }, { taskId: 1, text: 'Hello.' }));
  assert.equal(fresh.state.messages[0].seq, 2);
  assert.deepEqual(whatsNew(fresh.state, fresh.reg, 'a1', { afterSeq: 0 }).olderDropped, false);
});

test("a question to the human keeps its asker's name after it leaves the ring and the registry renames or forgets the asker", () => {
  const ctx = ctxWith({ tasks: [{ id: 1, title: 'Vegetarian filter' }, { id: 2, title: 'Chatter' }] });
  const jade = { ...ctx, agentId: 'a2' };
  apply(ctx, claimTask(jade, { id: 1 }));
  apply(ctx, postMessage(jade, { taskId: 1, kind: 'question', to: 'human', text: 'Metric or imperial?' }));
  for (let i = 0; i < MESSAGE_RING; i++) apply(ctx, postMessage(ctx, { taskId: 2, text: `Note ${i}` }));
  assert.equal(ctx.state.messages.some((m) => m.taskId === 1), false); // the question left the ring
  const askedBy = () => needsHuman(ctx.state, ctx.reg, DEFAULTS, T0).questions.map((q) => q.askedBy);
  ctx.reg.agents.a2.name = 'Cobalt'; // renamed when she came back (§4): history keeps "Jade"
  assert.deepEqual(askedBy(), ['Jade']);
  delete ctx.reg.agents.a2; // forgotten
  assert.deepEqual(askedBy(), ['Jade']);
  assert.equal(getTask(ctx.state, ctx.reg, 1, []).openQuestions[0].authorName, 'Jade');
});

test('pings and needs-you items carry their own fields only', () => {
  const question = { id: 'm1', to: 'human', author: 'a2', authorName: 'Jade', at: T0, text: 'Oven time?' };
  const ctx = ctxWith({
    tasks: [
      { id: 1, title: 'Vegetarian filter', assignee: 'a1', openQuestions: [{ ...question, extra: { deep: 1 } }] },
      { id: 2, approved: false, origin: 'agent', createdBy: 'a2', title: 'Cache photos' },
    ],
  });
  apply(ctx, postMessage({ ...ctx, agentId: 'a2' }, { taskId: 1, text: 'Hello.' }));
  /** @type {any} */ (ctx.state.messages[0]).internal = { deep: 1 }; // as in a hand-edited snapshot
  const [ping] = whatsNew(ctx.state, ctx.reg, 'a1', {}).items;
  assert.deepEqual(Object.keys(ping).sort(), ['authorName', 'message', 'reason']);
  assert.deepEqual(Object.keys(ping.message).sort(), [
    'about', 'at', 'author', 'authorName', 'holder', 'id', 'kind', 'mentions', 'relayedFromHuman', 'replyTo', 'replyToAuthor', 'seq', 'taskId', 'text', 'to',
  ]);
  const n = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0);
  assert.deepEqual(n.questions, [{ taskId: 1, title: 'Vegetarian filter', question, askedBy: 'Jade' }]);
  assert.deepEqual(n.approvals, [{ id: 2, title: 'Cache photos', suggestedBy: 'Jade' }]);
  assert.deepEqual(getTask(ctx.state, ctx.reg, 1, []).openQuestions, [question]);
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

test('stalled lists every claim housekeeping releases for inactivity, including an idle holder that never ended', () => {
  const ctx = ctxWith({ tasks: [{ id: 9, title: 'Cache photos', assignee: 'a2', claim: { folder: '/w/b', since: T0 } }] });
  // Jade's terminal was killed: no SessionEnd, so her session never ended; she is only idle
  const io = { host: 'test-host', missing: () => false, alive: () => true };
  const due = T0 + 24 * HOUR;
  for (const now of [due - 1, due, due + 1, due + HOUR]) {
    const { stalled } = needsHuman(ctx.state, ctx.reg, DEFAULTS, now);
    const released = maintenance(ctx.state, structuredClone(ctx.reg), DEFAULTS, now, io).some((e) => e.type === 'task.released');
    assert.equal(stalled.length === 1, released, `${now - due} ms after the release time`);
    // releaseAt at or before now: due at the next write
    if (released) assert.deepEqual(stalled, [{ id: 9, title: 'Cache photos', since: T0, releaseAt: due }]);
  }
  assert.equal(ctx.reg.agents.a2.endedAt, null);
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
  const pings = whatsNew(ctx.state, ctx.reg, 'a1', {}).items;
  const n = needsHuman(ctx.state, ctx.reg, DEFAULTS, T0);
  assert.deepEqual({ state: ctx.state, reg: ctx.reg }, before);
  list.items[0].labels.push('x');
  view.messages[0].mentions.push(99);
  view.openQuestions[0].text = 'changed';
  pings[0].message.mentions.push(99);
  n.questions[0].question.text = 'changed';
  assert.deepEqual({ state: ctx.state, reg: ctx.reg }, before);
});
