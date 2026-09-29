import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTask } from '../../src/core/reduce.js';
import { columnOf, blockers, epicProgress, readyQueue, wouldCycle, epicPath, COLUMNS } from '../../src/core/derive.js';

const tasksOf = (...list) => Object.fromEntries(list.map((t) => [t.id, newTask(t)]));

test('display order of columns', () => {
  assert.deepEqual(COLUMNS, ['backlog', 'ready', 'in_progress', 'blocked', 'done']);
});

test('each rule and its precedence (§5)', () => {
  const tasks = tasksOf(
    { id: 1, done: true, approved: false },
    { id: 2, approved: false, dependsOn: [5] },
    { id: 3, dependsOn: [5], assignee: 'a1' },
    { id: 4, assignee: 'a1' },
    { id: 5 },
    { id: 6, openQuestions: [{ id: 'm1', to: 'human', author: 'a1', at: 0, text: 'q' }] },
    { id: 7, kind: 'epic' },
  );
  assert.equal(columnOf(tasks[1], tasks), 'done');
  assert.equal(columnOf(tasks[2], tasks), 'backlog');
  assert.equal(columnOf(tasks[3], tasks), 'blocked');
  assert.equal(columnOf(tasks[4], tasks), 'in_progress');
  assert.equal(columnOf(tasks[5], tasks), 'ready');
  assert.equal(columnOf(tasks[6], tasks), 'blocked');
  assert.equal(columnOf(tasks[7], tasks), null);
});

test('blockers list dependencies and open questions; done dependencies do not block', () => {
  const tasks = tasksOf(
    { id: 1, dependsOn: [2, 3], openQuestions: [{ id: 'm9', to: 'a2', author: 'a1', at: 0, text: 'q' }] },
    { id: 2, done: true },
    { id: 3 },
  );
  assert.deepEqual(blockers(tasks[1], tasks), [
    { type: 'dependency', id: 3 },
    { type: 'question', id: 'm9', to: 'a2' },
  ]);
});

test('epic progress counts sub-epic tasks; epicPath names the chain', () => {
  const tasks = tasksOf(
    { id: 1, kind: 'epic', title: 'Recipe search' },
    { id: 2, kind: 'epic', title: 'Filters', parent: 1 },
    { id: 3, parent: 1, done: true },
    { id: 4, parent: 2, done: true },
    { id: 5, parent: 2 },
    { id: 6 },
  );
  assert.deepEqual(epicProgress(1, tasks), { done: 2, total: 3 });
  assert.deepEqual(epicProgress(2, tasks), { done: 1, total: 2 });
  assert.equal(epicPath(tasks[5], tasks), 'Recipe search › Filters');
  assert.equal(epicPath(tasks[6], tasks), '');
});

test('ready queue is ordered by rank, then id', () => {
  const tasks = tasksOf({ id: 1, rank: 5 }, { id: 2, rank: 1 }, { id: 3, rank: 1 }, { id: 4, rank: 0, done: true });
  assert.deepEqual(readyQueue(tasks).map((t) => t.id), [2, 3, 1]);
});

test('wouldCycle detects direct and indirect cycles', () => {
  const tasks = tasksOf({ id: 1, dependsOn: [2] }, { id: 2, dependsOn: [3] }, { id: 3 });
  assert.equal(wouldCycle(tasks, 3, 1), true);
  assert.equal(wouldCycle(tasks, 1, 1), true);
  assert.equal(wouldCycle(tasks, 1, 3), false);
});

test('inherited keys such as __proto__ never resolve to a task', () => {
  const tasks = tasksOf({ id: 1, dependsOn: ['__proto__'] }, { id: 2, parent: '__proto__' });
  assert.equal(wouldCycle(tasks, 1, '__proto__'), false);
  assert.deepEqual(blockers(tasks[1], tasks), []);
  assert.equal(epicPath(tasks[2], tasks), '');
});
