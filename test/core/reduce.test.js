import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, emptyState, isEvent, newTask, snippet, FILES_LIMIT, RECENT_LIMIT, MESSAGE_RING,
} from '../../src/core/reduce.js';
import { T0 } from '../helpers.js';

let seq = 0;
const ev = (type, data, actor = 'a1') => ({ seq: ++seq, at: T0 + seq, type, actor, data });
/** An event as it comes back from the log, where JSON.parse makes "__proto__" an own key. */
const raw = (type, dataJson) => JSON.parse(`{"seq":${++seq},"at":${T0 + seq},"type":"${type}","actor":"a1","data":${dataJson}}`);
const created = (id, extra = {}) =>
  ev('task.created', { task: { id, kind: 'task', title: `Task ${id}`, origin: 'human', createdBy: 'human', approved: true, rank: id, ...extra } });
const msg = (id, taskId, kind, extra = {}) =>
  ev('message.posted', { message: { id, at: T0, taskId, author: 'a1', kind, text: `${kind} text`, mentions: [], ...extra } });

function board(...events) {
  const s = emptyState();
  for (const e of events) applyEvent(s, e);
  return s;
}

test('task.created fills defaults, advances nextId and logs activity', () => {
  const s = board(created(1), created(2, { origin: 'agent', createdBy: 'a1', approved: false }));
  assert.equal(s.nextId, 3);
  assert.equal(s.tasks[1].done, false);
  assert.deepEqual(s.tasks[1].checklist, []);
  assert.equal(s.tasks[1].assignee, null);
  assert.deepEqual(s.recent.map((r) => r.type), ['created', 'suggested']);
  assert.equal(s.seq, s.recent[1].seq);
});

test('claim, release and complete', () => {
  const s = board(created(1));
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a1', folder: '/w' }));
  assert.equal(s.tasks[1].assignee, 'a1');
  assert.equal(s.tasks[1].claim.folder, '/w');
  applyEvent(s, ev('task.released', { id: 1, reason: 'timeout' }, 'system'));
  assert.equal(s.tasks[1].assignee, null);
  assert.equal(s.tasks[1].claim, null);
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a2', folder: '/w' }, 'a2'));
  applyEvent(s, ev('task.completed', { id: 1, summary: 'Done it.' }, 'a2'));
  const t = s.tasks[1];
  assert.equal(t.done, true);
  assert.equal(t.completedBy, 'a2');
  assert.equal(t.summary, 'Done it.');
  assert.equal(t.assignee, null);
  assert.deepEqual(s.recent.map((r) => r.type), ['created', 'claimed', 'auto-released', 'claimed', 'completed']);
});

test('questions open and close; answers remember who asked', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'question', { to: 'human' }));
  assert.equal(s.tasks[1].openQuestions.length, 1);
  assert.equal(s.tasks[1].openQuestions[0].to, 'human');
  applyEvent(s, msg('m2', 1, 'answer', { replyTo: 'm1', author: 'a2', relayedFromHuman: true }));
  assert.deepEqual(s.tasks[1].openQuestions, []);
  const answer = s.messages.at(-1);
  assert.equal(answer.replyToAuthor, 'a1');
  assert.equal(answer.relayedFromHuman, true);
  assert.equal(s.tasks[1].messageCount, 2);
  assert.deepEqual(s.recent.slice(-2).map((r) => r.type), ['question', 'answer']);
});

test('handoff and summary become lastHandoff; system messages can close questions and log', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'question', { to: 'any' }));
  applyEvent(s, msg('m2', 1, 'handoff', { text: 'Next: wire the API.' }));
  assert.equal(s.tasks[1].lastHandoff.text, 'Next: wire the API.');
  applyEvent(s, msg('m3', 1, 'system', { author: 'system', closesQuestions: true, about: 'unblocked', text: '#7 is done — #1 is unblocked.' }));
  assert.deepEqual(s.tasks[1].openQuestions, []);
  assert.equal(s.recent.at(-1).type, 'unblocked');
});

test('checklist logs only newly checked items; files are deduplicated', () => {
  const s = board(created(1));
  applyEvent(s, ev('task.checklist', { id: 1, items: [{ text: 'A', done: true }, { text: 'B', done: false }] }));
  applyEvent(s, ev('task.checklist', { id: 1, items: [{ text: 'A', done: true }, { text: 'B', done: true }] }));
  assert.deepEqual(s.recent.filter((r) => r.type === 'checked').map((r) => r.text), ['A', 'B']);
  applyEvent(s, ev('task.file', { id: 1, path: 'src/a.js', by: 'a1' }));
  applyEvent(s, ev('task.file', { id: 1, path: 'src/a.js', by: 'a2' }));
  assert.deepEqual(s.tasks[1].files.map((f) => f.path), ['src/a.js']);
});

test('update and approve', () => {
  const s = board(created(1, { approved: false, origin: 'agent' }));
  applyEvent(s, ev('task.updated', { id: 1, changes: { title: 'Renamed', labels: ['bug'] } }));
  applyEvent(s, ev('task.approved', { id: 1, approved: true }, 'a2'));
  assert.equal(s.tasks[1].title, 'Renamed');
  assert.deepEqual(s.tasks[1].labels, ['bug']);
  assert.equal(s.tasks[1].approved, true);
  assert.equal(s.recent.at(-1).type, 'approved');
});

test('unknown events and unknown tasks are ignored', () => {
  const s = board(created(1));
  applyEvent(s, ev('something.new', { id: 1 }));
  applyEvent(s, ev('task.claimed', { id: 99, agent: 'a1' }));
  assert.equal(s.tasks[1].assignee, null);
  assert.equal(s.tasks[99], undefined);
});

test('message ring entries carry the seq of their event, which grows in commit order even when times do not', () => {
  const s = board(created(1));
  const first = msg('m1', 1, 'comment');
  // its writer read the clock before it got the lock, so it is stamped earlier than the message before it
  const second = { ...msg('m2', 1, 'comment'), at: first.at - 500 };
  applyEvent(s, first);
  applyEvent(s, second);
  assert.deepEqual(s.messages.map((m) => [m.id, m.seq, m.at]), [['m1', first.seq, first.at], ['m2', second.seq, first.at - 500]]);
});

test('rings are bounded', () => {
  const s = board(created(1));
  for (let i = 0; i < RECENT_LIMIT + 10; i++) applyEvent(s, msg(`q${i}`, 1, 'question'));
  assert.equal(s.recent.length, RECENT_LIMIT);
  assert.equal(s.messages.length, MESSAGE_RING);
});

test('isEvent accepts plain objects with a string type and a safe seq of 1 or more', () => {
  assert.equal(isEvent({ seq: 1, type: 'x' }), true);
  for (const bad of [
    null, 42, 'task.created', [], {}, { type: 'x' }, { seq: 1 }, { seq: 1, type: 7 }, { seq: 0, type: 'x' },
    { seq: -1, type: 'x' }, { seq: 1.5, type: 'x' }, { seq: '1', type: 'x' }, { seq: 2 ** 53, type: 'x' },
  ]) assert.equal(isEvent(bad), false, JSON.stringify(bad));
});

test('seq must strictly increase: older or equal events and non-events are ignored', () => {
  const s = emptyState();
  applyEvent(s, { ...created(1), seq: 10 });
  assert.equal(s.seq, 10);
  applyEvent(s, { ...created(2), seq: 3 });
  applyEvent(s, { ...created(3), seq: 10 });
  assert.equal(s.seq, 10);
  assert.deepEqual(Object.keys(s.tasks), ['1']);
  for (const bad of [null, 42, [], { type: 'task.created' }, { seq: 99, type: 5 }, { seq: 2 ** 53, type: 'x' }]) {
    applyEvent(s, /** @type {any} */ (bad));
  }
  assert.equal(s.seq, 10);
  applyEvent(s, { ...ev('something.new', {}), seq: 11 }); // unknown types still advance seq
  assert.equal(s.seq, 11);
});

test('applying the same event twice changes nothing', () => {
  const s = board(created(1));
  const events = [
    created(2), ev('task.updated', { id: 1, changes: { title: 'Renamed' } }), ev('task.approved', { id: 1, approved: true }),
    ev('task.claimed', { id: 1, agent: 'a1', folder: '/w' }), ev('task.file', { id: 1, path: 'src/a.js', by: 'a1' }),
    ev('task.checklist', { id: 1, items: [{ text: 'A', done: true }] }), msg('m1', 1, 'question'), msg('m2', 1, 'handoff'),
    ev('task.released', { id: 1, reason: 'manual' }), ev('task.completed', { id: 1, summary: 'Done.' }),
  ];
  for (const e of events) {
    applyEvent(s, e);
    const once = JSON.stringify(s);
    applyEvent(s, e);
    applyEvent(s, JSON.parse(JSON.stringify(e)));
    assert.equal(JSON.stringify(s), once, e.type);
  }
  assert.equal(s.tasks[1].messageCount, 2);
});

test('summary becomes lastHandoff with kind summary; lastHandoff keeps only a snippet', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'summary', { text: 'Built the filter.' }));
  assert.deepEqual(s.tasks[1].lastHandoff, { author: 'a1', at: s.messages[0].at, kind: 'summary', text: 'Built the filter.' });
  applyEvent(s, msg('m2', 1, 'handoff', { text: `Next:\n\n${'x'.repeat(5000)}` }));
  assert.equal(s.tasks[1].lastHandoff.kind, 'handoff');
  assert.ok(s.tasks[1].lastHandoff.text.length <= 280);
  assert.ok(s.tasks[1].lastHandoff.text.startsWith('Next: xxx'));
});

test('releases: manual or unknown reasons log released, folder-missing and timeout log auto-released', () => {
  const s = board(created(1));
  for (const reason of ['manual', 'folder-missing', 'timeout', undefined, 'other']) {
    applyEvent(s, ev('task.claimed', { id: 1, agent: 'a1', folder: '/w' }));
    applyEvent(s, ev('task.released', { id: 1, reason }, 'system'));
  }
  assert.deepEqual(s.recent.filter((r) => r.type.endsWith('released')).map((r) => r.type), [
    'released', 'auto-released', 'auto-released', 'released', 'released',
  ]);
});

test('completion clears open questions; approved: false logs nothing', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'question', { to: 'human' }));
  applyEvent(s, ev('task.approved', { id: 1, approved: false }));
  assert.equal(s.tasks[1].approved, false);
  assert.equal(s.recent.at(-1).type, 'question');
  applyEvent(s, ev('task.completed', { id: 1, summary: 'Done.' }));
  assert.deepEqual(s.tasks[1].openQuestions, []);
  assert.equal(s.recent.at(-1).type, 'completed');
});

test('comments and handoffs are kept as headers but log no activity', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'comment'));
  applyEvent(s, msg('m2', 1, 'handoff'));
  assert.deepEqual(s.recent.map((r) => r.type), ['created']);
  assert.deepEqual(s.messages.map((m) => m.kind), ['comment', 'handoff']);
  assert.equal(s.tasks[1].messageCount, 2);
});

test('an answer to an unknown question id has no replyToAuthor and closes nothing', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'question'));
  applyEvent(s, msg('m2', 1, 'answer', { replyTo: 'nope' }));
  assert.equal(s.messages.at(-1).replyToAuthor, null);
  assert.deepEqual(s.tasks[1].openQuestions.map((q) => q.id), ['m1']);
});

test('a question without "to" is addressed to any, in the task and in the header', () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'question'));
  assert.equal(s.tasks[1].openQuestions[0].to, 'any');
  assert.equal(s.messages[0].to, 'any');
  applyEvent(s, msg('m2', 1, 'comment'));
  assert.equal(s.messages[1].to, null);
});

test('a message for an unknown task changes nothing', () => {
  const s = board(created(1));
  const before = JSON.stringify({ ...s, seq: 0 });
  applyEvent(s, msg('m1', 99, 'question'));
  assert.equal(JSON.stringify({ ...s, seq: 0 }), before);
});

test('malformed events change nothing and never throw', () => {
  const s = board(created(1));
  const snapshot = () => JSON.stringify({ ...s, seq: 0 });
  const before = snapshot();
  const malformed = [
    null, 42, [], 'text',
    { seq: ++seq, at: T0, type: 'message.posted', actor: 'a1' }, // no data
    { seq: ++seq, at: T0, type: 'task.claimed', actor: 'a1', data: null },
    ev('message.posted', {}), // no message
    ev('message.posted', { message: 'hello' }),
    ev('task.checklist', { id: 1, items: 'abc' }),
    ev('task.checklist', { id: 1 }),
    ev('task.claimed', { id: 1 }), // no agent
    ev('task.claimed', { id: 1, agent: 7 }),
    ev('task.file', { id: 1 }), // no path
    ev('task.file', { id: 1, path: ['a'] }),
    ev('task.completed', { id: '1', summary: 'x' }),
    ev('task.completed', { id: 1.5, summary: 'x' }),
    ev('task.updated', { id: 1, changes: 'abc' }), // last: it only touches updatedAt
  ];
  for (const e of malformed) applyEvent(s, /** @type {any} */ (e));
  assert.equal(s.tasks[1].updatedAt, T0 + seq);
  s.tasks[1].updatedAt = s.tasks[1].createdAt;
  assert.equal(snapshot(), before);
});

test('taskId "__proto__", "constructor" and "1" match no task and pollute nothing', () => {
  const s = board(created(1));
  for (const taskId of ['"__proto__"', '"constructor"', '"toString"', '"1"']) {
    for (const kind of ['question', 'handoff', 'comment']) {
      applyEvent(s, raw('message.posted', `{"message":{"id":"m","taskId":${taskId},"author":"a1","kind":"${kind}","text":"hi"}}`));
    }
    applyEvent(s, raw('message.posted', `{"message":{"id":"m","taskId":${taskId},"author":"system","kind":"system","closesQuestions":true,"text":"hi"}}`));
    applyEvent(s, raw('task.completed', `{"id":${taskId},"summary":"x"}`));
    applyEvent(s, raw('task.updated', `{"id":${taskId},"changes":{"title":"x"}}`));
  }
  assert.deepEqual(s.messages, []);
  assert.equal(s.tasks[1].messageCount, 0);
  assert.equal(s.tasks[1].done, false);
  for (const probe of [{}, [], Object, Object.prototype]) {
    for (const k of ['messageCount', 'updatedAt', 'openQuestions', 'lastHandoff', 'done', 'title']) {
      assert.equal(Object.hasOwn(probe, k), false, k);
    }
  }
  assert.equal(/** @type {any} */ ({}).messageCount, undefined);
});

test('task.updated changes only editable fields', () => {
  const s = board(created(1));
  const changes = {
    id: 99, done: true, assignee: 'x', openQuestions: null, checklist: 'abc', messageCount: 'n', approved: false,
    title: 'Renamed', rank: 5, dependsOn: [2], labels: 'not-a-list',
  };
  applyEvent(s, raw('task.updated', `{"id":1,"changes":{"__proto__":{"polluted":true},${JSON.stringify(changes).slice(1)}}`));
  const t = s.tasks[1];
  assert.equal(t.id, 1);
  assert.equal(t.done, false);
  assert.equal(t.assignee, null);
  assert.deepEqual(t.openQuestions, []);
  assert.deepEqual(t.checklist, []);
  assert.equal(t.messageCount, 0);
  assert.equal(t.approved, true);
  assert.equal(t.title, 'Renamed');
  assert.equal(t.rank, 5);
  assert.deepEqual(t.dependsOn, [2]);
  assert.deepEqual(t.labels, []); // a non-list is ignored
  assert.equal(/** @type {any} */ (t).polluted, undefined);
  assert.equal(Object.hasOwn(t, '__proto__'), false);
  assert.deepEqual(Object.keys(s.tasks), ['1']);
  applyEvent(s, ev('task.updated', { id: 1, changes: { title: undefined, description: 'Kept' } }));
  assert.equal(t.title, 'Renamed');
  assert.equal(t.description, 'Kept');
});

test('task.created needs a new safe integer id; a duplicate keeps the first task', () => {
  const s = emptyState();
  for (const id of [0, -3, 1.5, '5', null, 2 ** 53, 1e308]) applyEvent(s, ev('task.created', { task: { id, title: 'x' } }));
  applyEvent(s, raw('task.created', '{"task":{"id":"__proto__","title":"x"}}'));
  applyEvent(s, ev('task.created', { task: { title: 'no id' } }));
  applyEvent(s, ev('task.created', {}));
  applyEvent(s, ev('task.created', { task: 'text' }));
  assert.deepEqual(s.tasks, {});
  assert.equal(s.nextId, 1);
  assert.deepEqual(s.recent, []);
  assert.equal(Object.getPrototypeOf(s.tasks), Object.prototype);

  applyEvent(s, created(1));
  applyEvent(s, ev('task.completed', { id: 1, summary: 'Done.' }));
  applyEvent(s, created(1, { title: 'Duplicate' }));
  assert.equal(s.tasks[1].title, 'Task 1');
  assert.equal(s.tasks[1].done, true);
  assert.deepEqual(s.recent.map((r) => r.type), ['created', 'completed']);
});

test('task.created takes only creation fields; derived state starts from the defaults', () => {
  const s = emptyState();
  const task = {
    id: 1, title: 'T', checklist: [null], files: [null], openQuestions: [null], done: true, assignee: 'x',
    claim: { folder: '/w', since: 1 }, lastHandoff: { text: 'x' }, completedBy: 'x', summary: 'x', messageCount: 'n',
    doneAt: 5, createdAt: 5, extra: 'junk',
  };
  applyEvent(s, raw('task.created', `{"task":{"__proto__":{"polluted":true},${JSON.stringify(task).slice(1)}}`));
  const at = s.tasks[1].createdAt;
  assert.deepEqual(s.tasks[1], newTask({ id: 1, title: 'T', createdAt: at, updatedAt: at }));
  assert.equal(/** @type {any} */ (s.tasks[1]).polluted, undefined);
  // the events that used to trip over null entries now just work
  applyEvent(s, ev('task.checklist', { id: 1, items: [{ text: 'A', done: true }] }));
  applyEvent(s, ev('task.file', { id: 1, path: 'src/a.js', by: 'a1' }));
  applyEvent(s, msg('m1', 1, 'answer', { replyTo: 'q1' }));
  const t = s.tasks[1];
  assert.deepEqual(t.checklist, [{ text: 'A', done: true }]);
  assert.deepEqual(t.files.map((f) => f.path), ['src/a.js']);
  assert.deepEqual(t.openQuestions, []);
  assert.equal(t.done, false);
  assert.equal(t.assignee, null);
  assert.equal(t.messageCount, 1);
});

test('task.created keeps typed values only: bad scalars take the default, lists keep their good entries', () => {
  const s = emptyState();
  applyEvent(s, ev('task.created', {
    task: {
      id: 1, kind: 'story', title: 5, description: {}, parent: '3', rank: 'first', approved: 'false', origin: 'bot',
      createdBy: 7, labels: ['bug', 1, null], dependsOn: [2, '3', 0, 1.5, 4, null],
      links: [{ title: 'Spec', target: 'docs/x.md', extra: 1 }, { title: 1, target: 'y' }, null, 'z'],
    },
  }));
  applyEvent(s, ev('task.created', { task: { id: 2, labels: 'bug', dependsOn: null, links: {}, parent: 1, approved: false, origin: 'agent' } }));
  const at1 = s.tasks[1].createdAt;
  assert.deepEqual(s.tasks[1], newTask({
    id: 1, labels: ['bug'], dependsOn: [2, 4], links: [{ title: 'Spec', target: 'docs/x.md' }], createdAt: at1, updatedAt: at1,
  }));
  const t2 = s.tasks[2];
  assert.deepEqual([t2.labels, t2.dependsOn, t2.links, t2.parent, t2.approved, t2.origin], [[], [], [], 1, false, 'agent']);
  assert.deepEqual(s.recent.map((r) => r.type), ['created', 'suggested']);
});

test('task.updated ignores values of the wrong type and filters lists', () => {
  const s = board(created(1, { parent: 5 }));
  applyEvent(s, ev('task.updated', {
    id: 1, changes: { title: 5, description: null, parent: '3', rank: 'x', labels: ['a', 2], dependsOn: [3, -1], links: [{ title: 'L' }] },
  }));
  const t = s.tasks[1];
  assert.deepEqual([t.title, t.description, t.parent, t.rank], ['Task 1', '', 5, 1]);
  assert.deepEqual([t.labels, t.dependsOn, t.links], [['a'], [3], []]);
  applyEvent(s, ev('task.updated', { id: 1, changes: { parent: null, rank: 2.5 } }));
  assert.deepEqual([t.parent, t.rank], [null, 2.5]);
});

test('messages need string id and kind; mentions, to and replyTo are typed', () => {
  const s = board(created(1));
  applyEvent(s, msg(7, 1, 'comment'));
  applyEvent(s, msg('m0', 1, 7));
  assert.equal(s.tasks[1].messageCount, 0);
  assert.deepEqual(s.messages, []);
  applyEvent(s, msg('m1', 1, 'question', { to: 5, mentions: ['1', 2, null, 1.5, 0, 3] }));
  assert.equal(s.tasks[1].openQuestions[0].to, 'any');
  assert.deepEqual(s.messages[0].mentions, [2, 3]);
  applyEvent(s, msg('m2', 1, 'answer', { replyTo: ['m1'], to: { x: 1 } }));
  assert.deepEqual([s.messages[1].replyTo, s.messages[1].to, s.messages[1].replyToAuthor], [null, null, null]);
  assert.equal(s.tasks[1].openQuestions.length, 1);
  applyEvent(s, msg('m3', 1, 'comment', { mentions: 'x', relayedFromHuman: 'yes' }));
  assert.deepEqual([s.messages[2].mentions, s.messages[2].relayedFromHuman], [[], false]);
});

test('a time that is not a finite number is stored as null', () => {
  const s = emptyState();
  applyEvent(s, { ...created(1), at: 'yesterday' });
  applyEvent(s, { ...ev('task.claimed', { id: 1, agent: 'a1' }), at: null });
  assert.equal(s.tasks[1].createdAt, null);
  assert.equal(s.tasks[1].claim.since, null);
  assert.deepEqual(s.recent.map((r) => r.at), [null, null]);
});

test('checklist items must be objects with a string text', () => {
  const s = board(created(1));
  const items = [null, 'A', { text: 5, done: true }, { done: true }, { text: 'B', done: 1 }, { text: 'C' }];
  applyEvent(s, ev('task.checklist', { id: 1, items }));
  assert.deepEqual(s.tasks[1].checklist, [{ text: 'B', done: true }, { text: 'C', done: false }]);
  assert.deepEqual(s.recent.filter((r) => r.type === 'checked').map((r) => r.text), ['B']);
});

test('claims need a string agent; a missing folder is stored as null', () => {
  const s = board(created(1));
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a1' }));
  assert.deepEqual(s.tasks[1].claim, { folder: null, since: s.recent.at(-1).at });
  assert.equal(s.tasks[1].assignee, 'a1');
});

test('task files stop at FILES_LIMIT', () => {
  const s = board(created(1));
  for (let i = 0; i < FILES_LIMIT + 5; i++) applyEvent(s, ev('task.file', { id: 1, path: `src/f${i}.js`, by: 'a1' }));
  applyEvent(s, ev('task.file', { id: 1, path: 'src/f0.js', by: 'a1' })); // already listed
  assert.equal(s.tasks[1].files.length, FILES_LIMIT);
  assert.equal(s.tasks[1].files.at(-1).path, `src/f${FILES_LIMIT - 1}.js`);
  assert.equal(Object.hasOwn(s.tasks[1], 'filesMore'), false);
});

test('snippet collapses whitespace, stays within 280 characters and never splits an emoji', () => {
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(snippet('  a \n\t b  '), 'a b');
  assert.equal(snippet(null), '');
  const cut = snippet(`${'a'.repeat(278)}${emoji}${'b'.repeat(10)}`); // the emoji straddles the cut
  assert.ok(cut.isWellFormed());
  assert.equal(cut, `${'a'.repeat(278)}…`);
  const kept = snippet(`${'a'.repeat(277)}${emoji}${'b'.repeat(10)}`); // the emoji fits
  assert.equal(kept, `${'a'.repeat(277)}${emoji}…`);
  assert.equal(kept.length, 280);
  assert.equal(snippet('x'.repeat(280)), 'x'.repeat(280));
});

test('a snapshot kept up to date event by event equals a fresh replay of the log', () => {
  const events = [
    created(1), created(2, { origin: 'agent', createdBy: 'a2', createdByName: ' Jade ', approved: false, labels: ['bug'] }),
    created(3, { kind: 'epic', description: undefined, dependsOn: undefined, requestedVia: 'a1', requestedViaName: undefined }),
    ev('task.updated', { id: 2, changes: { parent: 3, title: undefined, links: [{ title: 'Spec', target: 'docs/x.md' }] } }),
    ev('task.approved', { id: 2, approved: true }),
    ev('task.claimed', { id: 1, agent: 'a1', folder: undefined, agentName: 'Amber' }),
    ev('task.file', { id: 1, path: 'src/a.js', by: undefined }),
    ev('task.checklist', { id: 1, items: [{ text: 'A', done: true }, { text: 'B' }] }),
    msg('m1', 1, 'question', { to: undefined }),
    msg('m2', 1, 'answer', { replyTo: 'm1', author: 'a2', authorName: 'Jade', mentions: undefined }),
    msg('m3', 1, 'question', { to: 'human', authorName: undefined }),
    msg('m4', 1, 'handoff', { about: undefined }),
    msg('m5', 2, 'comment', { id: undefined, author: undefined, kind: undefined }), // ignored: no id or kind
    msg('m5b', 2, 'comment', { author: undefined, to: undefined, replyTo: undefined, text: undefined }),
    ev('task.released', { id: 1, reason: 'manual' }),
    ev('task.claimed', { id: 1, agent: 'a2', folder: '/w', agentName: 'x'.repeat(61) }, 'a2'),
    msg('m6', 1, 'summary', { text: `Done ${String.fromCodePoint(0x1f600)}` }),
    { ...ev('task.completed', { id: 1, summary: undefined, completedByName: 'Jade' }), actor: undefined },
    msg('m7', 2, 'system', { author: 'system', about: 'unblocked', closesQuestions: true, text: '#1 is done.' }),
    { seq: ++seq, type: 'task.file', data: { id: 2, path: 'src/b.js' } }, // no at, no actor
    null, { type: 'task.created' }, created(1, { title: 'Duplicate' }), ev('future.type', { id: 1 }),
  ];
  const lastSeq = seq;
  events.push(events[9], events.at(-1), { ...created(4), seq: 2 }); // repeated and out-of-order lines are no-ops
  const log = events.map((e) => JSON.stringify(e)).join('\n');

  let incremental = emptyState();
  for (const e of events) incremental = JSON.parse(JSON.stringify(applyEvent(incremental, /** @type {any} */ (e))));
  const replayed = emptyState();
  for (const line of log.split('\n')) applyEvent(replayed, JSON.parse(line));

  assert.deepStrictEqual(incremental, replayed);
  assert.equal(replayed.tasks[1].summary, null);
  assert.equal(replayed.tasks[1].completedBy, null);
  assert.equal(replayed.seq, lastSeq);
  assert.equal(replayed.tasks[4], undefined);
  assert.equal(replayed.tasks[2].messageCount, 2); // m5b and m7; m5 had no id or kind
  assert.equal(replayed.tasks[2].files[0].at, null);
  assert.deepEqual(
    [replayed.tasks[2].createdByName, replayed.tasks[3].requestedVia, replayed.tasks[3].requestedViaName],
    ['Jade', 'a1', null],
  );
  assert.deepEqual([replayed.tasks[1].assigneeName, replayed.tasks[1].completedByName], [null, 'Jade']);
  assert.deepEqual(replayed.messages.slice(0, 3).map((m) => m.authorName), [null, 'Jade', null]);
});

test('creation events carry display names: trimmed, up to 60 characters, else ignored', () => {
  const s = board(
    created(1, { origin: 'agent', createdBy: 'a1', createdByName: '  Amber  ', approved: false }),
    created(2, { requestedVia: 'a2', requestedViaName: 'Jade' }),
    created(3, { createdByName: 'x'.repeat(61), requestedVia: '', requestedViaName: '   ' }),
    created(4, { createdByName: 7, requestedVia: ['a1'], requestedViaName: { name: 'Jade' } }),
    created(5, { createdByName: 'y'.repeat(60), requestedVia: ' a3 ' }),
    created(6, { assigneeName: 'Amber', completedByName: 'Amber' }), // not creation fields
  );
  const names = (t) => [t.createdByName, t.requestedVia, t.requestedViaName];
  assert.deepEqual(names(s.tasks[1]), ['Amber', null, null]);
  assert.deepEqual(names(s.tasks[2]), [null, 'a2', 'Jade']);
  assert.deepEqual(names(s.tasks[3]), [null, null, null]);
  assert.deepEqual(names(s.tasks[4]), [null, null, null]);
  assert.deepEqual(names(s.tasks[5]), ['y'.repeat(60), ' a3 ', null]); // an id is kept exactly as given
  assert.deepEqual([s.tasks[6].assigneeName, s.tasks[6].completedByName], [null, null]);
  applyEvent(s, ev('task.updated', { id: 1, changes: { createdByName: 'Jade', requestedViaName: 'Jade', assigneeName: 'Jade' } }));
  assert.deepEqual([s.tasks[1].createdByName, s.tasks[1].requestedViaName, s.tasks[1].assigneeName], ['Amber', null, null]);
});

test("a claim stores the holder's name; release and completion clear it; completion stores its own name", () => {
  const s = board(created(1));
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a1', folder: '/w', agentName: ' Amber ' }));
  assert.equal(s.tasks[1].assigneeName, 'Amber');
  applyEvent(s, ev('task.released', { id: 1, reason: 'manual' }));
  assert.equal(s.tasks[1].assigneeName, null);
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a1', folder: '/w', agentName: 'Amber' }));
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a2', folder: '/w' }, 'a2')); // a claim without a name forgets the old one
  assert.deepEqual([s.tasks[1].assignee, s.tasks[1].assigneeName], ['a2', null]);
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a2', folder: '/w', agentName: 42 }, 'a2'));
  assert.equal(s.tasks[1].assigneeName, null);
  applyEvent(s, ev('task.claimed', { id: 1, agent: 'a2', folder: '/w', agentName: 'Jade' }, 'a2'));
  applyEvent(s, ev('task.completed', { id: 1, summary: 'Done.', completedByName: 'Jade' }, 'a2'));
  const t = s.tasks[1];
  assert.deepEqual([t.assignee, t.assigneeName, t.completedBy, t.completedByName], [null, null, 'a2', 'Jade']);
  const s2 = board(created(1));
  applyEvent(s2, ev('task.completed', { id: 1, summary: 'Done.', completedByName: 'z'.repeat(61) }));
  assert.equal(s2.tasks[1].completedByName, null);
});

test("message headers carry the author's display name", () => {
  const s = board(created(1));
  applyEvent(s, msg('m1', 1, 'comment', { authorName: ' Amber ' }));
  applyEvent(s, msg('m2', 1, 'comment'));
  applyEvent(s, msg('m3', 1, 'comment', { authorName: 'n'.repeat(61) }));
  applyEvent(s, msg('m4', 1, 'comment', { authorName: ['Amber'] }));
  applyEvent(s, msg('m5', 1, 'system', { author: 'system', authorName: '' }));
  assert.deepEqual(s.messages.map((m) => m.authorName), ['Amber', null, null, null, null]);
});

test('duplicate dependsOn ids are collapsed, on create and on update', () => {
  const s = board(created(1, { dependsOn: [2, 3, 2, 3, 2] }));
  assert.deepEqual(s.tasks[1].dependsOn, [2, 3]);
  applyEvent(s, ev('task.updated', { id: 1, changes: { dependsOn: [4, 4, 5] } }));
  assert.deepEqual(s.tasks[1].dependsOn, [4, 5]);
});
