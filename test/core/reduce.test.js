import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyState, RECENT_LIMIT, MESSAGE_RING } from '../../src/core/reduce.js';
import { T0 } from '../helpers.js';

let seq = 0;
const ev = (type, data, actor = 'a1') => ({ seq: ++seq, at: T0 + seq, type, actor, data });
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

test('rings are bounded', () => {
  const s = board(created(1));
  for (let i = 0; i < RECENT_LIMIT + 10; i++) applyEvent(s, msg(`q${i}`, 1, 'question'));
  assert.equal(s.recent.length, RECENT_LIMIT);
  assert.equal(s.messages.length, MESSAGE_RING);
});
