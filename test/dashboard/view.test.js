import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBoard, readState, readRegistry, emptyRegistry, transact } from '../../src/core/store.js';
import { getAgent, touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { claimTask, completeTask, touchTaskFile, updateTask } from '../../src/core/ops.js';
import { applyEvent, emptyState, RECENT_LIMIT } from '../../src/core/reduce.js';
import { buildView, withDeadEnded, SHOWN_ACTIVITY, UNKNOWN_COLOR } from '../../src/dashboard/view.js';
import { buildRecipesBoard, FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { tempRepo, MIN, HOUR } from '../helpers.js';

const NOW = Date.UTC(2026, 8, 30, 15, 0);
const MIDNIGHT = Date.UTC(2026, 8, 30, 0, 0);

function fixtureView(extra = {}) {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  return buildView({ state: readState(board), reg: readRegistry(board), cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT,
    projectName: 'recipes-app', badLines: 0, host: null, alive: () => true, ...extra });
}

// ---------- hand-built states for the edge rules ----------

/** A state from events applied in order (seq 1, 2, …); each event's `at` defaults to 1 h before NOW. */
function stateOf(events) {
  const state = emptyState();
  events.forEach((e, i) => applyEvent(state, { seq: i + 1, at: NOW - HOUR, actor: 'human', actorName: null, ...e }));
  return state;
}
/** A task.created event; approved, human-made, rank = id unless given. */
const created = (id, task = {}, ev = {}) => ({ type: 'task.created', data: { task: { id, kind: 'task', title: `Task ${id}`, approved: true, rank: id, ...task } }, ...ev });
const claimed = (id, agent, agentName = null, ev = {}) => ({ type: 'task.claimed', actor: agent, actorName: agentName, data: { id, agent, agentName }, ...ev });
let questions = 0;
const question = (taskId, to, author, ev = {}) => ({
  type: 'message.posted', actor: author, data: { message: { id: `q${++questions}`, taskId, author, kind: 'question', to, text: `Question to ${to}?` } }, ...ev,
});
const agent = (id, name, extra = {}) => ({
  id, name, color: '#4F6B1F', folder: null, pid: null, host: null, branch: null, firstSeen: NOW - 2 * HOUR, lastSeen: NOW - MIN, endedAt: null, ...extra,
});
function regOf(...agents) {
  const reg = emptyRegistry();
  for (const a of agents) reg.agents[a.id] = a;
  return reg;
}
const viewOf = (state, reg, extra = {}) => buildView({ state, reg, cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT, projectName: 'p',
  badLines: 0, host: null, alive: () => true, ...extra });

// ---------- the fixture board ----------

test('header and counts', () => {
  const v = fixtureView();
  assert.equal(v.project, 'recipes-app');
  assert.equal(v.now, NOW);
  assert.equal(v.badLines, 0);
  assert.ok(Number.isSafeInteger(v.seq) && v.seq > 0);
  assert.equal(v.activeCount, 2); // Amber and Jade; Cobalt ended
  assert.deepEqual(v.counts, { backlog: 2, ready: 3, in_progress: 2, blocked: 2, done: 2, suggested: 2 }); // #9 stays In progress: its holder is gone, not the claim
});

test('Needs you: the question to the human, the grouped suggestions and the stalled claim', () => {
  const { needsYou: n } = fixtureView();
  assert.equal(n.count, 3);
  assert.deepEqual(n.questions.map((q) => [q.kind, q.taskId, q.title, q.askedBy]), [['question', ID.prepTime, 'Filter by prep time', 'Jade']]);
  assert.equal(n.questions[0].text, 'Should "quick" mean under 15 or under 30 minutes?');
  assert.ok(typeof n.questions[0].questionId === 'string' && n.questions[0].at <= NOW);
  assert.equal(n.approvals.kind, 'approve');
  assert.deepEqual(n.approvals.ids, [ID.cachePhotos, ID.darkMode]);
  assert.deepEqual(n.approvals.items.map((a) => [a.id, a.title, a.suggestedBy]),
    [[ID.cachePhotos, 'Cache recipe photos', 'Amber'], [ID.darkMode, 'Dark mode for the recipe view', 'Jade']]);
  assert.deepEqual(n.stalled.map((s) => [s.kind, s.id, s.title, s.holderName]), [['stalled', ID.photoUpload, 'Profile photo upload', 'Cobalt']]);
  assert.ok(n.stalled[0].releaseAt > NOW);
  assert.ok(n.stalled[0].since < NOW);
});

test('Now: one card per live agent with its task, checklist, pill and last file', () => {
  const v = fixtureView();
  assert.deepEqual(v.agents.map((a) => a.name).sort(), ['Amber', 'Jade']);
  const amber = v.agents.find((a) => a.name === 'Amber');
  assert.deepEqual(amber.task, { id: ID.vegetarian, title: 'Vegetarian filter' });
  assert.deepEqual(amber.checklist, { done: 3, total: 5 });
  assert.equal(amber.status, 'active');
  assert.equal(amber.pill, 'In progress');
  assert.equal(amber.initial, 'A');
  assert.equal(amber.color, '#A45F00');
  assert.equal(amber.lastFile, 'src/filters/diet.js');
  assert.equal(amber.blockedReason, null);
  assert.equal(amber.lastActivityAt, NOW - 2 * MIN);
  const jade = v.agents.find((a) => a.name === 'Jade');
  assert.equal(jade.pill, 'Blocked');
  assert.equal(jade.blockedReason, 'Waiting for your answer');
  assert.equal(jade.lastFile, null);
  assert.equal(jade.checklist, null); // no checklist on #6
  assert.equal(v.agents.some((a) => a.name === 'Cobalt'), false);
  assert.deepEqual(v.agents.map((a) => a.name), ['Amber', 'Jade']); // order of arrival
});

test('Shipped today, epics, next in line, labels', () => {
  const v = fixtureView();
  assert.deepEqual(v.shippedToday.map((s) => s.id), [ID.rounding, ID.byIngredient]); // newest first
  assert.deepEqual(v.shippedToday.map((s) => s.agentName), ['Amber', 'Jade']);
  assert.equal(v.shippedToday[0].summary, 'Rounding now keeps one decimal for grams and none for cups.');
  assert.equal(v.shippedToday[0].title, 'Fix the unit conversion rounding');
  assert.deepEqual(v.epics.map((e) => [e.title, e.depth, e.parent]), [['Search', 0, null], ['Filters', 1, ID.search], ['Accounts', 0, null]]);
  const search = v.epics.find((e) => e.id === ID.search);
  assert.deepEqual([search.done, search.total], [1, 4]); // #4 done of #4, #5, #6, #13 (sub-epic tasks count)
  assert.deepEqual(v.nextInLine.map((n) => [n.position, n.id]), [[1, ID.passwordReset], [2, ID.rememberMe], [3, ID.favorites]]);
  assert.deepEqual(v.nextInLine.map((n) => n.epicPath), ['Accounts', 'Accounts', '']);
  assert.deepEqual(v.labels, [{ name: 'improvement', count: 2 }, { name: 'ui', count: 2 }, { name: 'bug', count: 1 }]);
});

test('cards: blockers, stalled chip and meta per column', () => {
  const v = fixtureView();
  const card = (id) => v.cards.find((c) => c.id === id);
  assert.equal(v.cards.length, 11); // tasks only, no epics
  assert.deepEqual(card(ID.prepTime).blockers, [{ kind: 'human' }]);
  assert.deepEqual(card(ID.pagination).blockers, [{ kind: 'dependency', id: ID.vegetarian }]);
  assert.deepEqual(card(ID.pagination).meta, { kind: 'waits', id: ID.vegetarian, backTo: 'Ready' });
  assert.deepEqual(card(ID.cachePhotos).meta, { kind: 'origin', suggestedBy: 'Amber' });
  assert.equal(card(ID.cachePhotos).suggested, true);
  assert.equal(card(ID.cachePhotos).firstLabel, 'improvement');
  assert.equal(card(ID.passwordReset).suggested, false);
  assert.equal(card(ID.passwordReset).firstLabel, null);
  assert.deepEqual(card(ID.passwordReset).meta, { kind: 'queue', position: 1 });
  assert.deepEqual(card(ID.favorites).meta, { kind: 'queue', position: 3 });
  assert.equal(card(ID.vegetarian).meta.kind, 'progress');
  assert.deepEqual(card(ID.vegetarian).meta.checklist, { done: 3, total: 5 });
  assert.equal(card(ID.vegetarian).meta.lastActivityAt, NOW - 2 * MIN);
  assert.deepEqual(card(ID.vegetarian).assignee, { id: 'fixture-amber', name: 'Amber', color: '#A45F00' });
  assert.equal(card(ID.vegetarian).stalled, null);
  assert.deepEqual(card(ID.vegetarian).blockers, []); // blockers only in Blocked
  assert.ok(card(ID.photoUpload).stalled);
  assert.ok(card(ID.photoUpload).stalled.since < NOW);
  assert.equal(card(ID.photoUpload).assignee.name, 'Cobalt');
  assert.deepEqual(card(ID.photoUpload).meta, { kind: 'progress', checklist: null, lastActivityAt: null }); // the stalled chip carries the time
  assert.deepEqual(card(ID.prepTime).meta, { kind: 'progress', checklist: null, lastActivityAt: NOW - 2 * MIN }); // a question only: still the holder's progress
  assert.deepEqual(card(ID.rounding).meta, { kind: 'done', at: card(ID.rounding).doneAt });
  assert.deepEqual(card(ID.vegetarian).epicIds, [ID.filters, ID.search]);
  assert.equal(card(ID.vegetarian).epicPath, 'Search › Filters');
  assert.deepEqual(card(ID.favorites).epicIds, []);
  assert.equal(card(ID.favorites).epicPath, '');
  assert.equal(card(ID.cachePhotos).assignee, null);
});

test('Done cards carry who completed them; the holder stays the assignee', () => {
  const v = fixtureView();
  const card = (id) => v.cards.find((c) => c.id === id);
  assert.deepEqual(card(ID.byIngredient).completer, { id: 'fixture-jade', name: 'Jade', color: '#17735A' });
  assert.deepEqual(card(ID.rounding).completer, { id: 'fixture-amber', name: 'Amber', color: '#A45F00' });
  assert.equal(card(ID.byIngredient).assignee, null); // agent filters follow the holder, not the completer
  assert.ok(v.cards.filter((c) => c.column !== 'done').every((c) => c.completer === null));
});

test('cards come in board order: column, then rank; Done newest first', () => {
  const v = fixtureView();
  assert.deepEqual(v.cards.map((c) => [c.column, c.id]), [
    ['backlog', ID.cachePhotos], ['backlog', ID.darkMode],
    ['ready', ID.passwordReset], ['ready', ID.rememberMe], ['ready', ID.favorites],
    ['in_progress', ID.vegetarian], ['in_progress', ID.photoUpload],
    ['blocked', ID.prepTime], ['blocked', ID.pagination],
    ['done', ID.rounding], ['done', ID.byIngredient],
  ]);
});

test('activity: newest first, names kept, file edits never shown', () => {
  const v = fixtureView();
  assert.ok(v.activity.length > 5);
  // one event can log several entries (three checklist items at once): they share a seq and keep their order
  assert.ok(v.activity.every((e, i, all) => i === 0 || all[i - 1].seq >= e.seq));
  assert.ok(v.activity.every((e) => SHOWN_ACTIVITY.includes(e.type)));
  assert.deepEqual(v.activity.filter((e) => e.type === 'checked').map((e) => e.text), ['Diet field on recipes', 'Filter in the API', 'Toggle in the UI']);
  const done = v.activity.find((e) => e.type === 'completed' && e.taskId === ID.byIngredient);
  assert.equal(done.actorName, 'Jade');
  assert.equal(done.taskTitle, 'Search by ingredient');
  assert.equal(v.activity[0].type, 'question');
  assert.ok(v.activity.some((e) => e.type === 'claimed' && e.actorName === 'Cobalt')); // an ended agent keeps its name
});

test('a live agent of this host whose process is gone counts as ended', () => {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  const reg = readRegistry(board);
  for (const a of Object.values(reg.agents)) { a.host = 'h1'; a.pid = a.name === 'Amber' ? 111 : 222; }
  const eff = withDeadEnded(reg, { host: 'h1', alive: (pid) => pid !== 111, now: NOW, cfg: DEFAULTS });
  const amber = Object.values(eff.agents).find((a) => a.name === 'Amber');
  assert.equal(amber.endedAt, NOW);
  assert.equal(Object.values(reg.agents).find((a) => a.name === 'Amber').endedAt, null); // input untouched
  assert.equal(Object.values(eff.agents).find((a) => a.name === 'Jade').endedAt, null); // alive
  // another host's pids mean nothing here
  const other = withDeadEnded(reg, { host: 'h2', alive: () => false, now: NOW, cfg: DEFAULTS });
  assert.equal(Object.values(other.agents).every((a) => a.name === 'Cobalt' || a.endedAt === null), true);
  const v = buildView({ state: readState(board), reg, cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT, projectName: 'p',
    badLines: 0, host: 'h1', alive: (pid) => pid !== 111 });
  assert.equal(v.agents.some((a) => a.name === 'Amber'), false);
  assert.equal(v.activeCount, 1);
  assert.ok(v.needsYou.stalled.some((s) => s.id === ID.vegetarian && s.holderName === 'Amber'));
  assert.ok(v.cards.find((c) => c.id === ID.vegetarian).stalled);
});

test('a live agent not seen for claimTimeoutHours counts as ended, on any host', () => {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  const reg = readRegistry(board);
  const due = NOW - 2 * MIN + DEFAULTS.claimTimeoutHours * HOUR; // Amber and Jade were last seen 2 min before NOW
  const endedAt = (now) => Object.fromEntries(Object.values(withDeadEnded(reg, { host: null, alive: () => true, now, cfg: DEFAULTS }).agents)
    .map((a) => [a.name, a.endedAt]));
  const cobaltEnded = Object.values(reg.agents).find((a) => a.name === 'Cobalt').endedAt;
  assert.deepEqual(endedAt(due), { Amber: null, Jade: null, Cobalt: cobaltEnded }); // exactly the timeout: still live
  assert.deepEqual(endedAt(due + 1), { Amber: due + 1, Jade: due + 1, Cobalt: cobaltEnded });
  // Now empties, and the cards' stalled chips agree with Needs you
  const v = buildView({ state: readState(board), reg, cfg: DEFAULTS, now: due + HOUR, midnight: MIDNIGHT, projectName: 'p',
    badLines: 0, host: null, alive: () => true });
  assert.deepEqual([v.agents, v.activeCount], [[], 0]);
  assert.deepEqual(v.needsYou.stalled.map((s) => [s.id, s.holderName]), [[ID.vegetarian, 'Amber'], [ID.prepTime, 'Jade'], [ID.photoUpload, 'Cobalt']]);
  assert.deepEqual(v.cards.filter((c) => c.stalled).map((c) => c.id).sort((a, b) => a - b), [ID.vegetarian, ID.prepTime, ID.photoUpload]);
});

test('Now: the last file shows only when it was edited during the current claim', () => {
  const repo = tempRepo();
  const board = buildRecipesBoard(repo, { now: NOW });
  const amber = 'fixture-amber';
  const op = (fn, input, at) => transact(board, (state, reg, now) => {
    touchAgent(reg, { id: amber, folder: repo, seq: state.seq }, now);
    return { events: fn({ state, reg, cfg: DEFAULTS, agentId: amber, now }, input).events, registry: reg };
  }, { now: at });
  const card = (now) => buildView({ state: readState(board), reg: readRegistry(board), cfg: DEFAULTS, now, midnight: MIDNIGHT,
    projectName: 'p', badLines: 0, host: null, alive: () => true }).agents.find((a) => a.name === 'Amber');
  // her checklist is finished first: a task is completed with every item done
  const ticked = readState(board).tasks[ID.vegetarian].checklist.map((i) => ({ text: i.text, done: true }));
  op(updateTask, { id: ID.vegetarian, checklist: ticked }, NOW + MIN);
  op(completeTask, { id: ID.vegetarian, summary: 'Done.' }, NOW + MIN);
  assert.deepEqual([card(NOW + MIN).task, card(NOW + MIN).lastFile], [null, 'src/filters/diet.js']); // no task: the last file stays
  op(claimTask, { id: ID.passwordReset }, NOW + 2 * MIN);
  assert.deepEqual([card(NOW + 2 * MIN).task.id, card(NOW + 2 * MIN).lastFile], [ID.passwordReset, null]); // #5's file is not #7's
  // her first edit on #7, recorded as the PostToolUse hook does
  transact(board, (state, reg, now) => {
    const { events } = touchTaskFile({ state, reg, cfg: DEFAULTS, agentId: amber, now }, 'src/auth/reset.js');
    Object.assign(getAgent(reg, amber), { lastSeen: now, lastFile: 'src/auth/reset.js', lastFileAt: now });
    return { events, registry: reg };
  }, { now: NOW + 3 * MIN });
  assert.equal(card(NOW + 3 * MIN).lastFile, 'src/auth/reset.js');
});

// ---------- edge rules on hand-built states ----------

test('names: the holder from the registry, then the claim; history from the stored name; never a raw id', () => {
  const state = stateOf([
    created(1), created(2), created(3), created(4, { title: 'Suggested', approved: false, origin: 'agent', createdBy: 'ag-pruned', createdByName: 'Rust' }, { actor: 'ag-pruned', actorName: 'Rust' }),
    claimed(1, 'ag-known', 'Old name'),
    claimed(2, 'ag-pruned', 'Rust'),
    claimed(3, 'ag-nameless'),
    { type: 'message.posted', actor: 'system', data: { message: { id: 's1', taskId: 3, author: 'system', kind: 'system', about: 'unblocked', text: '#9 is done' } } },
    { type: 'task.updated', actor: 'ag-known', data: { id: 1, changes: { title: 'Renamed' } } }, // not an activity
    { type: 'task.approved', actor: 'ag-gone', data: { id: 4, approved: true } },
  ]);
  const reg = regOf(agent('ag-known', 'Plum'));
  const v = viewOf(state, reg);
  const card = (id) => v.cards.find((c) => c.id === id);
  assert.deepEqual(card(1).assignee, { id: 'ag-known', name: 'Plum', color: '#4F6B1F' });
  assert.equal(card(1).stalled, null);
  assert.equal(card(2).assignee.name, 'Rust');
  assert.ok(card(2).stalled); // the registry no longer knows it: gone
  assert.equal(card(3).assignee.name, 'an earlier agent');
  assert.match(card(3).assignee.color, /^#[0-9A-F]{6}$/i);
  assert.deepEqual(v.needsYou.stalled.map((s) => [s.id, s.holderName]), [[2, 'Rust'], [3, 'an earlier agent']]);
  const byType = Object.fromEntries(v.activity.map((e) => [`${e.type}:${e.taskId}`, e]));
  assert.equal(byType['claimed:1'].actorName, 'Old name'); // the name when it was written
  assert.equal(byType['claimed:3'].actorName, 'an earlier agent');
  assert.equal(byType['unblocked:3'].actorName, 'system');
  assert.equal(byType['approved:4'].actorName, 'an earlier agent');
  assert.equal(byType['suggested:4'].actorName, 'Rust');
  assert.equal(byType['claimed:1'].taskTitle, 'Renamed'); // the current title
  // no raw agent id anywhere but the ids meant for filtering
  const text = JSON.stringify({ ...v, cards: v.cards.map((c) => ({ ...c, assignee: c.assignee && { ...c.assignee, id: null } })), agents: [] });
  assert.equal(/ag-(known|pruned|nameless|gone)/.test(text), false);
});

test('activity: the registry name when none was stored; a task that is gone has no title; other kinds are left out', () => {
  const state = stateOf([
    created(1, {}, { actor: 'ag-forgotten' }),
    claimed(1, 'ag-a'),
    { type: 'message.posted', actor: 'system', data: { message: { id: 's1', taskId: 1, author: 'system', kind: 'system', about: 'something-new', text: 'x' } } },
  ]);
  state.recent.push({ seq: 99, at: NOW, type: 'completed', taskId: 42, actor: 'ag-a', actorName: null, text: 'Old task' });
  const v = viewOf(state, regOf(agent('ag-a', 'Teal')));
  assert.deepEqual(v.activity.map((e) => [e.seq, e.type, e.taskId, e.taskTitle, e.actorName]), [
    [99, 'completed', 42, null, 'Teal'],
    [2, 'claimed', 1, 'Task 1', 'Teal'],
    [1, 'created', 1, 'Task 1', 'an earlier agent'],
  ]);
});

test('blockers and blocked reasons: dependencies, the human, a named agent, any agent', () => {
  const state = stateOf([
    created(1), created(2, { dependsOn: [1] }), created(3), created(4), created(5, { dependsOn: [1] }), created(6, { dependsOn: [1] }),
    created(7, { dependsOn: [1] }),
    claimed(2, 'ag-x'), claimed(3, 'ag-y'), claimed(4, 'ag-w'), claimed(5, 'ag-v'), claimed(1, 'ag-z'),
    question(3, 'ag-z', 'ag-y'), question(3, 'ag-z', 'ag-y'), question(3, 'ag-gone', 'ag-y'),
    question(4, 'any', 'ag-w'),
    question(5, 'human', 'ag-v'),
    { type: 'task.completed', actor: 'ag-q', data: { id: 6 } }, // done with an open dependency
  ]);
  const reg = regOf(agent('ag-x', 'Plum'), agent('ag-y', 'Rust'), agent('ag-w', 'Moss'), agent('ag-v', 'Ruby'), agent('ag-z', 'Teal'));
  const v = viewOf(state, reg);
  const card = (id) => v.cards.find((c) => c.id === id);
  const reason = (name) => v.agents.find((a) => a.name === name).blockedReason;
  assert.deepEqual(card(2).blockers, [{ kind: 'dependency', id: 1 }]);
  assert.deepEqual(card(2).meta, { kind: 'waits', id: 1, backTo: 'In progress' });
  assert.equal(reason('Plum'), 'Waiting on #1');
  assert.deepEqual(card(3).blockers, [{ kind: 'agent', name: 'Teal' }, { kind: 'agent', name: 'an earlier agent' }]); // one chip per addressee
  assert.equal(reason('Rust'), 'Waiting for Teal');
  assert.deepEqual(card(4).blockers, [{ kind: 'any' }]);
  assert.equal(reason('Moss'), 'Waiting for any agent');
  assert.deepEqual(card(5).blockers, [{ kind: 'dependency', id: 1 }, { kind: 'human' }]);
  assert.equal(reason('Ruby'), 'Waiting for your answer'); // the human's answer comes first
  assert.equal(card(5).meta.kind, 'waits');
  assert.deepEqual(card(6).blockers, []); // Done never waits
  assert.deepEqual(card(7).meta, { kind: 'waits', id: 1, backTo: 'Ready' });
  assert.equal(v.agents.find((a) => a.name === 'Teal').pill, 'In progress');
  assert.equal(v.agents.find((a) => a.name === 'Rust').pill, 'Blocked');
  // questions to agents are not the human's business
  assert.deepEqual(v.needsYou.questions.map((q) => q.taskId), [5]);
  assert.equal(v.needsYou.approvals, null);
  assert.equal(v.needsYou.count, 1);
});

test('a card blocked only by a question and held by nobody has no meta', () => {
  const state = stateOf([created(1), question(1, 'human', 'ag-a')]);
  const v = viewOf(state, regOf(agent('ag-a', 'Amber')));
  assert.equal(v.cards[0].column, 'blocked');
  assert.equal(v.cards[0].meta, null);
});

test('Now: idle and taskless agents in order of arrival, ended agents left out', () => {
  const state = stateOf([created(1, { title: 'Held' }), claimed(1, 'ag-idle')]);
  const reg = regOf(
    agent('ag-late', 'Teal', { firstSeen: NOW - 2 * HOUR, lastSeen: NOW - 30 * MIN }),
    agent('ag-free', 'amber', { firstSeen: NOW - 2 * HOUR, lastSeen: NOW - 3 * MIN }),
    agent('ag-idle', 'Jade', { firstSeen: NOW - 3 * HOUR, lastSeen: NOW - HOUR }),
    agent('ag-ended', 'Cobalt', { firstSeen: NOW - 4 * HOUR, lastSeen: NOW - MIN, endedAt: NOW - MIN }),
  );
  const v = viewOf(state, reg);
  // firstSeen, oldest first; the id breaks the tie; being seen later never moves a card
  assert.deepEqual(v.agents.map((a) => [a.name, a.status, a.pill]), [['Jade', 'idle', 'Idle'], ['amber', 'active', 'No task'], ['Teal', 'idle', 'Idle']]);
  reg.agents['ag-late'].lastSeen = NOW;
  assert.deepEqual(viewOf(state, reg).agents.map((a) => a.name), ['Jade', 'amber', 'Teal']);
  const free = v.agents[1];
  assert.deepEqual([free.id, free.initial, free.task, free.checklist, free.blockedReason, free.lastFile], ['ag-free', 'A', null, null, null, null]);
  assert.equal(free.lastActivityAt, NOW - 3 * MIN);
  assert.deepEqual(v.agents[0].task, { id: 1, title: 'Held' });
  assert.equal(v.activeCount, 1);
});

test('epics: tree order by rank, sub-epics under their parent, an orphan sub-epic at the top', () => {
  const state = stateOf([
    created(1, { kind: 'epic', title: 'B', rank: 20 }),
    created(2, { kind: 'epic', title: 'A', rank: 10 }),
    created(3, { kind: 'epic', title: 'B2', parent: 1, rank: 5 }),
    created(4, { kind: 'epic', title: 'B1', parent: 1, rank: 1 }),
    created(5, { kind: 'epic', title: 'Orphan', parent: 99, rank: 15 }),
    created(6, { parent: 4 }), created(7, { parent: 1 }), created(8, { parent: 3, labels: ['x', 'x'] }),
    { type: 'task.completed', actor: 'ag', data: { id: 6 } },
  ]);
  const v = viewOf(state, emptyRegistry());
  assert.deepEqual(v.epics.map((e) => [e.title, e.depth, e.parent, e.done, e.total]), [
    ['A', 0, null, 0, 0], ['Orphan', 0, null, 0, 0], ['B', 0, null, 1, 3], ['B1', 1, 1, 1, 1], ['B2', 1, 1, 0, 1],
  ]);
  assert.deepEqual(v.cards.find((c) => c.id === 6).epicIds, [4, 1]);
  assert.deepEqual(v.labels, [{ name: 'x', count: 1 }]);
});

test('Shipped today starts at midnight; the completer from the stored name, then the registry', () => {
  const state = stateOf([
    created(1), created(2), created(3),
    { type: 'task.completed', actor: 'ag-a', at: MIDNIGHT - MIN, data: { id: 1, summary: 'Yesterday.', completedByName: 'Amber' } },
    { type: 'task.completed', actor: 'ag-a', at: MIDNIGHT, data: { id: 2, summary: 'At midnight.' } },
    { type: 'task.completed', actor: 'ag-b', at: NOW - MIN, data: { id: 3, summary: null, completedByName: 'Jade' } },
  ]);
  const v = viewOf(state, regOf(agent('ag-a', 'Plum')));
  assert.deepEqual(v.shippedToday.map((s) => [s.id, s.agentName, s.doneAt, s.summary]), [[3, 'Jade', NOW - MIN, null], [2, 'Plum', MIDNIGHT, 'At midnight.']]);
  assert.deepEqual(v.cards.map((c) => c.id), [3, 2, 1]); // Done: newest first
  // the completer: the stored name, then the registry's; gray, and no id, when the registry does not know the agent
  assert.deepEqual(v.cards.map((c) => c.completer), [
    { id: null, name: 'Jade', color: UNKNOWN_COLOR }, { id: 'ag-a', name: 'Plum', color: '#4F6B1F' }, { id: 'ag-a', name: 'Amber', color: '#4F6B1F' },
  ]);
});

test('buildView is pure: no clock, inputs unchanged, results share nothing with them', () => {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  const state = readState(board);
  const reg = readRegistry(board);
  for (const a of Object.values(reg.agents)) { a.host = 'h1'; a.pid = a.name === 'Amber' ? 111 : 222; } // Amber's process is gone
  const before = structuredClone({ state, reg });
  const realNow = Date.now;
  Date.now = () => { throw new Error('buildView read the clock'); };
  let v;
  try {
    v = buildView({ state, reg, cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT, projectName: 'p', badLines: 2, host: 'h1', alive: (pid) => pid !== 111 });
  } finally {
    Date.now = realNow;
  }
  assert.equal(v.badLines, 2);
  assert.deepEqual(v.agents.map((a) => a.name), ['Jade']);
  assert.deepEqual({ state, reg }, before);
  // change every object and array of the result: the inputs stay the same
  const scribble = (x) => {
    if (Array.isArray(x)) { x.forEach(scribble); x.push('scribbled'); }
    else if (x && typeof x === 'object') { for (const k of Object.keys(x)) { scribble(x[k]); x[k] = 'scribbled'; } }
  };
  scribble(v);
  assert.deepEqual({ state, reg }, before);
});

test('performance: a 500-task board builds in well under 100 ms', (t) => {
  const BUDGET_MS = Number(process.env.PLANRELAY_PERF_BUDGET_MS ?? (process.env.CI ? 300 : 100));
  const EPICS = 20;
  const TASKS = 500;
  const AGENTS = 10;
  const events = [];
  const add = (type, data, actor = 'human', at = NOW - 10 * HOUR + events.length * 1000) =>
    events.push({ seq: events.length + 1, at, type, actor, actorName: actor === 'human' ? null : `Agent ${actor}`, data });
  for (let e = 1; e <= EPICS; e++) {
    add('task.created', { task: { id: e, kind: 'epic', title: `Epic ${e}`, parent: e % 4 === 0 ? e - 1 : null, rank: e } });
  }
  for (let i = EPICS + 1; i <= EPICS + TASKS; i++) {
    const agentMade = i % 10 === 0;
    add('task.created', {
      task: {
        id: i, kind: 'task', title: `Task ${i}`, description: 'x'.repeat(200), parent: 1 + (i % EPICS), labels: [`label-${i % 7}`, 'common'],
        dependsOn: i % 3 === 0 && i > EPICS + 1 ? [i - 1] : [], origin: agentMade ? 'agent' : 'human', createdBy: agentMade ? 'a1' : 'human',
        approved: !agentMade, rank: i,
      },
    });
  }
  for (let i = EPICS + 1; i <= EPICS + TASKS; i += 5) add('task.completed', { id: i, summary: `Did ${i}.` }, `a${i % AGENTS}`);
  for (let n = 0; n < AGENTS; n++) {
    const id = EPICS + 2 + n * 10; // never one of the done tasks (EPICS + 1 + 5k)
    add('task.claimed', { id, agent: `a${n}`, agentName: `Agent ${n}`, folder: null }, `a${n}`);
    add('task.checklist', { id, items: [{ text: 'one', done: true }, { text: 'two', done: false }] }, `a${n}`);
    if (n % 3 === 0) add('message.posted', { message: { id: `m${n}`, taskId: id, author: `a${n}`, kind: 'question', to: 'human', text: 'Which one?' } }, `a${n}`);
  }
  const state = emptyState();
  for (const ev of events) applyEvent(state, ev);
  assert.equal(state.recent.length, RECENT_LIMIT); // a full activity ring
  const reg = emptyRegistry();
  for (let n = 0; n < AGENTS; n++) {
    reg.agents[`a${n}`] = agent(`a${n}`, `Agent ${n}`, { lastSeen: NOW - n * MIN, endedAt: n === AGENTS - 1 ? NOW - MIN : null, host: 'h', pid: 100 + n });
  }
  const input = { state, reg, cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT, projectName: 'p', badLines: 0, host: 'h', alive: (pid) => pid !== 105 };
  const first = buildView(input); // warm-up, not timed
  assert.equal(first.cards.length, TASKS);
  assert.equal(first.agents.length, AGENTS - 2); // one ended, one with a dead process
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    buildView(input);
    times.push(performance.now() - start);
  }
  const median = [...times].sort((a, b) => a - b)[2];
  t.diagnostic(`buildView on ${TASKS} tasks: median ${median.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
  assert.ok(median < BUDGET_MS, `median ${median.toFixed(1)} ms is over the ${BUDGET_MS} ms budget`);
});
