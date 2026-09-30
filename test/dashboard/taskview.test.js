import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry, openBoard, readMessages, readRegistry, readState } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { BoardError } from '../../src/core/ops.js';
import { applyEvent, emptyState, FILES_LIMIT, RECENT_LIMIT } from '../../src/core/reduce.js';
import { buildTaskView } from '../../src/dashboard/taskview.js';
import { buildView, UNKNOWN_COLOR } from '../../src/dashboard/view.js';
import { buildRecipesBoard, FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { HOUR, MIN, tempRepo } from '../helpers.js';

const NOW = Date.UTC(2026, 8, 30, 15, 0);
const AMBER = '#A45F00';
const JADE = '#17735A';
const COBALT = '#2F4DB5';

/** @type {{ board: any, state: any, reg: any } | undefined} */
let fixture;
/** The fixture board, built once: buildTaskView never changes its inputs (see the purity test). */
function recipes() {
  if (!fixture) {
    const repo = tempRepo();
    buildRecipesBoard(repo, { now: NOW });
    const board = openBoard(repo);
    fixture = { board, state: readState(board), reg: readRegistry(board) };
  }
  return fixture;
}

/** The task view of a fixture task, with its message file. */
function taskView(id, extra = {}) {
  const { board, state, reg } = recipes();
  return buildTaskView({ state, reg, cfg: DEFAULTS, now: NOW, id, messages: readMessages(board, id), host: null, alive: () => true, ...extra });
}

// ---------- hand-built states ----------

/** A state from events applied in order (seq 1, 2, …); each event's `at` defaults to 1 h before NOW. */
function stateOf(events) {
  const state = emptyState();
  events.forEach((e, i) => applyEvent(state, { seq: i + 1, at: NOW - HOUR, actor: 'human', actorName: null, ...e }));
  return state;
}
/** A task.created event; approved, human-made, rank = id unless given. */
const created = (id, task = {}, ev = {}) => ({ type: 'task.created', data: { task: { id, kind: 'task', title: `Task ${id}`, approved: true, rank: id, ...task } }, ...ev });
const claimed = (id, agent, agentName = null, ev = {}) => ({ type: 'task.claimed', actor: agent, actorName: agentName, data: { id, agent, agentName }, ...ev });
/** A message as it is in the task's message file and in its message.posted event. */
const msg = (id, taskId, author, authorName, kind, extra = {}) => ({
  id, taskId, author, authorName, kind, to: null, replyTo: null, relayedFromHuman: false, mentions: [], at: NOW - 30 * MIN, text: `${kind} ${id}`, ...extra,
});
const posted = (m) => ({ type: 'message.posted', actor: m.author, data: { message: m } });
const agent = (id, name, color, extra = {}) => ({
  id, name, color, folder: null, pid: null, host: null, branch: null, firstSeen: NOW - 2 * HOUR, lastSeen: NOW - MIN, endedAt: null, ...extra,
});
function regOf(...agents) {
  const reg = emptyRegistry();
  for (const a of agents) reg.agents[a.id] = a;
  return reg;
}
const viewOf = (state, reg, id, extra = {}) => buildTaskView({ state, reg, cfg: DEFAULTS, now: NOW, id, messages: [], host: null, alive: () => true, ...extra });

// ---------- the fixture board ----------

test('#5: breadcrumb, status, holder, checklist, files and what it blocks', () => {
  const { state } = recipes();
  const v = taskView(ID.vegetarian);
  assert.equal(v.id, ID.vegetarian);
  assert.equal(v.title, 'Vegetarian filter');
  assert.equal(v.kind, 'task');
  assert.deepEqual(v.breadcrumb, [{ id: ID.search, title: 'Search' }, { id: ID.filters, title: 'Filters' }]);
  assert.deepEqual([v.column, v.columnLabel], ['in_progress', 'In progress']);
  assert.deepEqual(v.status, { text: 'In progress', column: 'in_progress' });
  const t = state.tasks[ID.vegetarian];
  assert.deepEqual(v.assignee, { id: t.assignee, name: 'Amber', color: AMBER, since: t.claim.since, gone: false });
  assert.deepEqual(v.labels, ['improvement']);
  assert.equal(v.origin, 'requested by you');
  assert.equal(v.question, null);
  assert.equal(v.description, 'A toggle that hides recipes with meat or fish.');
  assert.deepEqual(v.checklist, {
    items: [
      { text: 'Diet field on recipes', done: true }, { text: 'Filter in the API', done: true }, { text: 'Toggle in the UI', done: true },
      { text: 'Empty state', done: false }, { text: 'Tests', done: false },
    ],
    done: 3,
    total: 5,
  });
  assert.deepEqual(v.files, [{ path: 'src/filters/diet.js', agentName: 'Amber' }]);
  assert.equal(v.filesMore, false);
  assert.deepEqual(v.dependsOn, []);
  assert.deepEqual(v.blocks, [{ id: ID.pagination, title: 'Search results pagination', column: 'blocked' }]);
  assert.deepEqual(v.links, []);
  assert.deepEqual(v.details, {
    status: 'In progress', agent: 'Amber', epic: 'Search › Filters', labels: ['improvement'], origin: 'Requested by you', createdAt: t.createdAt,
  });
  assert.deepEqual([v.summary, v.completedByName, v.doneAt], [null, null, null]);
  // Jade's comment, after the creation
  assert.deepEqual(v.conversation.map((m) => [m.tag, m.authorName]), [['CREATED', 'You'], ['COMMENT', 'Jade']]);
  const comment = v.conversation[1];
  assert.equal(comment.text, 'The prep-time filter will reuse the same toggle row; see #13 too.');
  assert.deepEqual([comment.authorKind, comment.authorColor, comment.relayedBy], ['agent', JADE, null]);
  assert.match(comment.id, /^m\d+$/);
});

test('#6: the question to the human as a callout and a QUESTION → YOU entry', () => {
  const v = taskView(ID.prepTime);
  assert.deepEqual(v.status, { text: 'Blocked · waiting on you', column: 'blocked' });
  assert.equal(v.details.status, 'Blocked');
  assert.equal(v.details.agent, 'Jade');
  assert.equal(v.question.text, 'Should "quick" mean under 15 or under 30 minutes?');
  assert.deepEqual([v.question.authorName, v.question.authorColor], ['Jade', JADE]);
  assert.ok(Number.isFinite(v.question.at) && v.question.at <= NOW);
  const entry = v.conversation.find((m) => m.id === v.question.id);
  assert.equal(entry.tag, 'QUESTION → YOU');
  assert.equal(entry.authorName, 'Jade');
  assert.equal(entry.text, v.question.text);
  assert.equal(entry.at, v.question.at);
});

test('the conversation starts with the creation, then the messages oldest first', () => {
  const { state } = recipes();
  const v = taskView(ID.prepTime);
  const [first, ...rest] = v.conversation;
  assert.deepEqual(first, {
    id: 'created', tag: 'CREATED', authorName: 'You', authorKind: 'human', authorColor: null, at: state.tasks[ID.prepTime].createdAt,
    text: 'Requested the task and put it in the Filters epic.', relayedBy: 'Jade',
  });
  assert.ok(rest.length > 0 && rest.every((m) => m.tag !== 'CREATED'));
  const times = v.conversation.map((m) => m.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  // a task without an epic
  assert.equal(taskView(ID.favorites).conversation[0].text, 'Requested the task.');
});

test('#9: Cobalt\'s handoff, and a holder whose session ended', () => {
  const { state } = recipes();
  const v = taskView(ID.photoUpload);
  const t = state.tasks[ID.photoUpload];
  assert.deepEqual(v.assignee, { id: t.assignee, name: 'Cobalt', color: COBALT, since: t.claim.since, gone: true });
  assert.deepEqual(v.status, { text: 'In progress', column: 'in_progress' }); // the claim stands until housekeeping releases it
  assert.deepEqual(v.conversation.map((m) => m.tag), ['CREATED', 'HANDOFF']);
  const handoff = v.conversation[1];
  assert.deepEqual([handoff.authorName, handoff.authorColor, handoff.authorKind], ['Cobalt', COBALT, 'agent']);
  assert.equal(handoff.text, 'Upload form done; next step: resize on the server before saving.');
  assert.equal(v.conversation[0].relayedBy, 'Cobalt'); // it relayed the human's request
  assert.deepEqual(v.labels, ['ui']);
  // created, claimed, released, claimed: the same entries the Activity feed shows for #9
  assert.deepEqual(v.timeline, { count: 4, truncated: false });
  const { reg } = recipes();
  const feed = buildView({ state, reg, cfg: DEFAULTS, now: NOW, midnight: NOW - 15 * HOUR, projectName: 'p', badLines: 0, host: null, alive: () => true });
  assert.equal(feed.activity.filter((e) => e.taskId === ID.photoUpload).length, v.timeline.count);
});

test('a suggestion: origin, status and creation entry name the agent', () => {
  const v = taskView(ID.cachePhotos);
  assert.equal(v.origin, 'suggested by Amber');
  assert.equal(v.details.origin, 'Suggested by Amber');
  assert.deepEqual(v.status, { text: 'Backlog · suggested', column: 'backlog' });
  assert.equal(v.assignee, null);
  assert.deepEqual(v.breadcrumb, []);
  assert.equal(v.details.epic, null);
  assert.deepEqual(v.conversation, [{
    id: 'created', tag: 'CREATED', authorName: 'Amber', authorKind: 'agent', authorColor: AMBER, at: recipes().state.tasks[ID.cachePhotos].createdAt,
    text: 'Suggested the task.', relayedBy: null,
  }]);
  assert.equal(taskView(ID.darkMode).origin, 'suggested by Jade');
});

test('dependencies: #13 depends on #5, which blocks it', () => {
  const v = taskView(ID.pagination);
  assert.deepEqual(v.dependsOn, [{ id: ID.vegetarian, title: 'Vegetarian filter', column: 'in_progress' }]);
  assert.deepEqual(v.blocks, []);
  assert.deepEqual(v.status, { text: `Blocked · waiting on #${ID.vegetarian}`, column: 'blocked' });
  assert.equal(v.assignee, null);
  assert.equal(v.details.agent, null);
});

test('a done task: summary, who completed it, and its messages', () => {
  const { state } = recipes();
  const v = taskView(ID.byIngredient);
  assert.deepEqual(v.status, { text: 'Done', column: 'done' });
  assert.equal(v.summary, 'Search by ingredient works from the search box, with tests for plurals.');
  assert.equal(v.completedByName, 'Jade');
  assert.equal(v.doneAt, state.tasks[ID.byIngredient].doneAt);
  assert.equal(v.assignee, null);
  assert.deepEqual(v.conversation.map((m) => [m.tag, m.authorName]), [['CREATED', 'You'], ['COMMENT', 'Jade'], ['SUMMARY', 'Jade']]);
  assert.deepEqual(v.checklist, { items: [], done: 0, total: 0 });
  assert.deepEqual(v.breadcrumb, [{ id: ID.search, title: 'Search' }]);
});

test('an epic has no column', () => {
  const v = taskView(ID.filters);
  assert.equal(v.kind, 'epic');
  assert.deepEqual([v.column, v.columnLabel], [null, 'Epic']);
  assert.deepEqual(v.status, { text: 'Epic', column: null });
  assert.deepEqual(v.breadcrumb, [{ id: ID.search, title: 'Search' }]);
  assert.equal(v.conversation[0].text, 'Requested the epic and put it in the Search epic.');
});

test('the timeline counts the task\'s activity in the ring', () => {
  const v = taskView(ID.prepTime);
  assert.ok(v.timeline.count > 0);
  assert.equal(v.timeline.truncated, false);
});

test('a task that does not exist is null; a malformed id is refused', () => {
  assert.equal(taskView(999), null);
  assert.throws(() => taskView('abc'), BoardError);
  assert.throws(() => taskView('5'), BoardError);
  assert.throws(() => taskView(0), BoardError);
});

test('a live agent of this host whose process is gone counts as ended', () => {
  const { reg } = recipes();
  const moved = structuredClone(reg);
  for (const a of Object.values(moved.agents)) { a.host = 'h1'; a.pid = a.name === 'Amber' ? 111 : 222; }
  const v = taskView(ID.vegetarian, { reg: moved, host: 'h1', alive: (pid) => pid !== 111 });
  assert.equal(v.assignee.gone, true);
  assert.equal(v.assignee.name, 'Amber');
  assert.equal(taskView(ID.prepTime, { reg: moved, host: 'h1', alive: (pid) => pid !== 111 }).assignee.gone, false);
});

// ---------- edge rules on hand-built states ----------

test('links: an href only for http(s) targets', () => {
  const state = stateOf([created(1, {
    links: [
      { title: 'Plan', target: 'docs/plan.md' }, { title: 'Spec', target: 'https://example.com/spec' },
      { title: 'Old', target: 'HTTP://example.com/old' }, { title: 'Script', target: 'javascript:alert(1)' },
      { title: 'Data', target: 'data:text/html,hi' }, { title: 'Slashes', target: '//example.com' },
    ],
  })]);
  const v = viewOf(state, regOf(), 1);
  assert.deepEqual(v.links, [
    { title: 'Plan', target: 'docs/plan.md', href: null },
    { title: 'Spec', target: 'https://example.com/spec', href: 'https://example.com/spec' },
    { title: 'Old', target: 'HTTP://example.com/old', href: 'HTTP://example.com/old' },
    { title: 'Script', target: 'javascript:alert(1)', href: null },
    { title: 'Data', target: 'data:text/html,hi', href: null },
    { title: 'Slashes', target: '//example.com', href: null },
  ]);
});

test('status texts: the human first, then the first blocker; any agent; a named agent', () => {
  const state = stateOf([
    created(1), created(2), created(3, { dependsOn: [1] }), created(4, { dependsOn: [1] }),
    posted(msg('q1', 2, 'ag-a', 'Teal', 'question', { to: 'ag-j' })),
    posted(msg('q2', 3, 'ag-a', 'Teal', 'question', { to: 'human' })),
    created(5), posted(msg('q3', 5, 'ag-a', 'Teal', 'question', { to: 'any' })),
    created(6), posted(msg('q4', 6, 'ag-a', 'Teal', 'question', { to: 'ag-forgotten' })),
    created(7, { approved: false, origin: 'human' }),
  ]);
  const reg = regOf(agent('ag-a', 'Teal', '#0F6E6E'), agent('ag-j', 'Jade', JADE));
  const status = (id) => viewOf(state, reg, id).status.text;
  assert.equal(status(1), 'Ready');
  assert.equal(status(2), 'Blocked · question to Jade');
  assert.equal(status(3), 'Blocked · waiting on you'); // the human's answer comes before the dependency
  assert.equal(status(4), 'Blocked · waiting on #1');
  assert.equal(status(5), 'Blocked · question to any agent');
  assert.equal(status(6), 'Blocked · question to an earlier agent');
  assert.equal(status(7), 'Backlog'); // not a suggestion
  assert.equal(viewOf(state, reg, 2).question, null); // only a question to the human is a callout
});

test('conversation tags and authors: relayed human words, questions, the system, forgotten agents', () => {
  const state = stateOf([created(1, { origin: 'agent', approved: true, createdBy: 'ag-a', createdByName: 'Teal' })]);
  const reg = regOf(agent('ag-a', 'Teal', '#0F6E6E'), agent('ag-j', 'Jade', JADE));
  const messages = [
    msg('m1', 1, 'ag-a', 'Teal', 'question', { to: 'human' }),
    msg('m2', 1, 'ag-j', 'Jade', 'answer', { replyTo: 'm1', relayedFromHuman: true, text: 'Under 15 minutes.' }),
    msg('m3', 1, 'ag-a', 'Teal', 'comment', { relayedFromHuman: true, text: 'Keep the old toggle.' }),
    msg('m4', 1, 'ag-a', 'Teal', 'question', { to: 'ag-j' }),
    msg('m5', 1, 'ag-a', 'Teal', 'question', { to: 'any' }),
    msg('m6', 1, 'ag-a', 'Teal', 'question', { to: 'ag-forgotten' }),
    msg('m7', 1, 'ag-j', 'Jade', 'answer', { replyTo: 'm4' }),
    msg('m8', 1, 'ag-a', 'Teal', 'handoff'),
    msg('m9', 1, 'system', 'system', 'system', { about: 'unblocked', text: '#2 is done — #1 is unblocked.' }),
    msg('m10', 1, 'ag-forgotten', null, 'comment'),
    msg('m11', 1, 'ag-renamed', 'Rust', 'comment'),
    msg('m12', 1, 'ag-a', 'Teal', 'summary'),
    msg('m13', 1, 'ag-a', 'Teal', 'some-new-kind'),
  ];
  const v = viewOf(state, reg, 1, { messages });
  const rows = v.conversation.map((m) => [m.id, m.tag, m.authorName, m.authorKind, m.authorColor, m.relayedBy]);
  assert.deepEqual(rows, [
    ['created', 'CREATED', 'Teal', 'agent', '#0F6E6E', null],
    ['m1', 'QUESTION → YOU', 'Teal', 'agent', '#0F6E6E', null],
    ['m2', 'ANSWER', 'You', 'human', null, 'Jade'],
    ['m3', 'COMMENT', 'You', 'human', null, 'Teal'],
    ['m4', 'QUESTION → JADE', 'Teal', 'agent', '#0F6E6E', null],
    ['m5', 'QUESTION → ANYONE', 'Teal', 'agent', '#0F6E6E', null],
    ['m6', 'QUESTION → AN EARLIER AGENT', 'Teal', 'agent', '#0F6E6E', null],
    ['m7', 'ANSWER', 'Jade', 'agent', JADE, null],
    ['m8', 'HANDOFF', 'Teal', 'agent', '#0F6E6E', null],
    ['m9', 'AUTOMATIC', 'System', 'system', null, null],
    ['m10', 'COMMENT', 'an earlier agent', 'agent', UNKNOWN_COLOR, null],
    ['m11', 'COMMENT', 'Rust', 'agent', UNKNOWN_COLOR, null], // the name stored with the message
    ['m12', 'SUMMARY', 'Teal', 'agent', '#0F6E6E', null],
    ['m13', 'COMMENT', 'Teal', 'agent', '#0F6E6E', null],
  ]);
  assert.equal(v.conversation[2].text, 'Under 15 minutes.');
  assert.equal(v.origin, 'suggested by Teal'); // agents' tasks need approval (the default): it was a suggestion
  assert.equal(viewOf(state, reg, 1, { cfg: { ...DEFAULTS, agentTasksNeedApproval: false } }).origin, 'created by Teal');
  assert.equal(viewOf(state, reg, 1, { cfg: { ...DEFAULTS, agentTasksNeedApproval: false } }).conversation[0].text, 'Created the task.');
});

test('the callout shows the full question from the message file, else the stored snippet', () => {
  const long = `${'Does prep time include oven time? '.repeat(12)}End.`;
  const q = msg('q1', 1, 'ag-a', 'Teal', 'question', { to: 'human', text: long });
  const state = stateOf([created(1), posted(q)]);
  const reg = regOf(agent('ag-a', 'Teal', '#0F6E6E'));
  assert.equal(viewOf(state, reg, 1, { messages: [q] }).question.text, long);
  const cut = viewOf(state, reg, 1).question;
  assert.ok(cut.text.length < long.length && cut.text.endsWith('…'));
  assert.deepEqual([cut.id, cut.authorName, cut.authorColor], ['q1', 'Teal', '#0F6E6E']);
});

test('names: holder from the registry, then the claim; files by who touched them; never a raw id', () => {
  const state = stateOf([
    created(1), claimed(1, 'ag-known', 'Old name'),
    created(2), claimed(2, 'ag-pruned', 'Rust'),
    created(3, { origin: 'agent', approved: false, createdBy: 'ag-pruned', createdByName: null }),
    { type: 'task.file', actor: 'ag-known', data: { id: 1, path: 'src/a.js', by: 'ag-known' } },
    { type: 'task.file', actor: 'ag-pruned', data: { id: 1, path: 'src/b.js', by: 'ag-pruned' } },
    { type: 'task.file', actor: 'ag-x', data: { id: 1, path: 'src/c.js', by: null } },
  ]);
  const reg = regOf(agent('ag-known', 'Plum', '#7A3E8E'));
  const one = viewOf(state, reg, 1);
  assert.deepEqual([one.assignee.name, one.assignee.color, one.assignee.gone], ['Plum', '#7A3E8E', false]);
  assert.deepEqual(one.files, [{ path: 'src/a.js', agentName: 'Plum' }, { path: 'src/b.js', agentName: 'an earlier agent' }, { path: 'src/c.js', agentName: 'an earlier agent' }]);
  const two = viewOf(state, reg, 2);
  assert.deepEqual([two.assignee.name, two.assignee.color, two.assignee.gone], ['Rust', UNKNOWN_COLOR, true]);
  const three = viewOf(state, reg, 3);
  assert.equal(three.origin, 'suggested by an earlier agent');
  assert.deepEqual([three.conversation[0].authorName, three.conversation[0].authorColor], ['an earlier agent', UNKNOWN_COLOR]);
  const text = JSON.stringify([{ ...one, assignee: null }, { ...two, assignee: null }, three]);
  assert.equal(/ag-(known|pruned|x)/.test(text), false);
});

test('files: "more" once the task reached FILES_LIMIT', () => {
  const files = Array.from({ length: FILES_LIMIT }, (_, i) => ({ type: 'task.file', actor: 'ag-a', data: { id: 1, path: `src/f${i}.js`, by: 'ag-a' } }));
  const reg = regOf(agent('ag-a', 'Teal', '#0F6E6E'));
  assert.equal(viewOf(stateOf([created(1), ...files.slice(1)]), reg, 1).filesMore, false);
  const v = viewOf(stateOf([created(1), ...files]), reg, 1);
  assert.equal(v.files.length, FILES_LIMIT);
  assert.equal(v.filesMore, true);
});

test('timeline: shown kinds only; truncated when the full ring no longer reaches the creation', () => {
  const state = stateOf([created(1), created(2), claimed(1, 'ag-a', 'Teal')]);
  const reg = regOf(agent('ag-a', 'Teal', '#0F6E6E'));
  assert.deepEqual(viewOf(state, reg, 1).timeline, { count: 2, truncated: false });
  // a full ring of task 1's checked items, its creation gone
  const checked = (i) => ({ seq: 10 + i, at: NOW, type: 'checked', taskId: 1, actor: 'ag-a', actorName: 'Teal', text: `step ${i}` });
  state.recent = Array.from({ length: RECENT_LIMIT }, (_, i) => checked(i));
  state.recent[3] = { ...state.recent[3], type: 'file-edited' }; // not a shown kind
  assert.deepEqual(viewOf(state, reg, 1).timeline, { count: RECENT_LIMIT - 1, truncated: true });
  assert.deepEqual(viewOf(state, reg, 2).timeline, { count: 0, truncated: true });
  // the creation still in the full ring
  state.recent[0] = { ...state.recent[0], type: 'created' };
  assert.deepEqual(viewOf(state, reg, 1).timeline, { count: RECENT_LIMIT - 1, truncated: false });
  state.recent[0] = { ...state.recent[0], type: 'suggested' };
  assert.equal(viewOf(state, reg, 1).timeline.truncated, false);
  // a ring that is not full holds everything
  state.recent = state.recent.slice(1);
  assert.equal(viewOf(state, reg, 2).timeline.truncated, false);
});

test('buildTaskView is pure: no clock, inputs unchanged, results share nothing with them', () => {
  const { board, state, reg } = recipes();
  const messages = readMessages(board, ID.prepTime);
  const before = structuredClone({ state, reg, messages });
  const realNow = Date.now;
  Date.now = () => { throw new Error('buildTaskView read the clock'); };
  let views;
  try {
    views = [ID.vegetarian, ID.prepTime, ID.photoUpload, ID.pagination, ID.byIngredient].map((id) =>
      buildTaskView({ state, reg, cfg: DEFAULTS, now: NOW, id, messages: id === ID.prepTime ? messages : readMessages(board, id), host: 'h1', alive: () => false }));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual({ state, reg, messages }, before);
  // change every object and array of the result: the inputs stay the same
  const scribble = (x) => {
    if (Array.isArray(x)) { x.forEach(scribble); x.push('scribbled'); }
    else if (x && typeof x === 'object') { for (const k of Object.keys(x)) { scribble(x[k]); x[k] = 'scribbled'; } }
  };
  scribble(views);
  assert.deepEqual({ state, reg, messages }, before);
});
