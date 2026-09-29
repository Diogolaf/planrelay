import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTask } from '../../src/core/reduce.js';
import {
  columnOf, blockers, isBlocked, epicProgress, epicTasks, childrenIndex, inEpic, readyQueue, wouldCycle, epicPath, COLUMNS, COLUMN_LABELS,
} from '../../src/core/derive.js';

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

const Q = { id: 'm1', to: 'human', author: 'a1', at: 0, text: 'q' };

test('deep nesting: progress counts every level and epicPath keeps the root', () => {
  const tasks = tasksOf(
    { id: 1, kind: 'epic', title: 'Root' },
    { id: 2, kind: 'epic', title: 'Sub', parent: 1 },
    { id: 3, kind: 'epic', title: 'SubSub', parent: 2 },
    { id: 4, kind: 'epic', title: 'SubSubSub', parent: 3 },
    { id: 5, parent: 4, done: true },
    { id: 6, parent: 3 },
    { id: 7, parent: 1 },
  );
  assert.deepEqual(epicProgress(1, tasks), { done: 1, total: 3 });
  assert.deepEqual(epicProgress(3, tasks), { done: 1, total: 2 });
  assert.equal(epicPath(tasks[5], tasks), 'Root › Sub › SubSub › SubSubSub');
  assert.equal(inEpic(tasks[5], 1, tasks), true);
  assert.equal(inEpic(tasks[7], 3, tasks), false);
  assert.deepEqual(epicTasks(1, tasks, childrenIndex(tasks)).map((t) => t.id).sort(), [5, 6, 7]);
});

test('parent cycles terminate and repeat no names', () => {
  const tasks = tasksOf(
    { id: 1, kind: 'epic', title: 'A', parent: 2 },
    { id: 2, kind: 'epic', title: 'B', parent: 1 },
    { id: 3, parent: 1 },
    { id: 4, parent: 2 },
  );
  assert.equal(epicPath(tasks[3], tasks), 'B › A');
  assert.deepEqual(epicProgress(1, tasks), { done: 0, total: 2 });
  assert.equal(inEpic(tasks[3], 99, tasks), false);
  const self = tasksOf({ id: 1, kind: 'epic', title: 'Solo', parent: 1 }, { id: 2, parent: 1 });
  assert.equal(epicPath(self[2], self), 'Solo');
  assert.deepEqual(epicProgress(1, self), { done: 0, total: 1 });
});

test('a plain task as parent is not shown in epicPath and is not walked', () => {
  const tasks = tasksOf({ id: 1, kind: 'epic', title: 'E' }, { id: 2, parent: 1 }, { id: 3, parent: 2 });
  assert.equal(epicPath(tasks[3], tasks), '');
  assert.equal(inEpic(tasks[3], 1, tasks), false);
  assert.deepEqual(epicProgress(1, tasks), { done: 0, total: 1 });
});

test('epicPath directly under a top-level epic; empty epic has no progress', () => {
  const tasks = tasksOf({ id: 1, kind: 'epic', title: 'Top' }, { id: 2, parent: 1 }, { id: 3, kind: 'epic', title: 'Empty' });
  assert.equal(epicPath(tasks[2], tasks), 'Top');
  assert.deepEqual(epicProgress(3, tasks), { done: 0, total: 0 });
  assert.deepEqual(epicProgress(1, tasks), { done: 0, total: 1 });
});

test('inEpic is false for the epic itself and for unrelated tasks', () => {
  const tasks = tasksOf({ id: 1, kind: 'epic', title: 'E' }, { id: 2, kind: 'epic', title: 'F', parent: 1 }, { id: 3, parent: 2 }, { id: 4 });
  assert.equal(inEpic(tasks[3], 1, tasks), true);
  assert.equal(inEpic(tasks[3], 2, tasks), true);
  assert.equal(inEpic(tasks[2], 1, tasks), true);
  assert.equal(inEpic(tasks[1], 1, tasks), false);
  assert.equal(inEpic(tasks[4], 1, tasks), false);
});

test('a dependency on a missing task counts as satisfied', () => {
  const tasks = tasksOf({ id: 1, dependsOn: [99] });
  assert.deepEqual(blockers(tasks[1], tasks), []);
  assert.equal(isBlocked(tasks[1], tasks), false);
  assert.equal(columnOf(tasks[1], tasks), 'ready');
});

test('Done beats Blocked; blockers ignores the column', () => {
  const tasks = tasksOf({ id: 1, done: true, dependsOn: [2], openQuestions: [Q] }, { id: 2 });
  assert.equal(columnOf(tasks[1], tasks), 'done');
  assert.deepEqual(blockers(tasks[1], tasks), [{ type: 'dependency', id: 2 }, { type: 'question', id: 'm1', to: 'human' }]);
  assert.equal(isBlocked(tasks[1], tasks), true);
});

test('isBlocked: open dependency or open question only', () => {
  const tasks = tasksOf(
    { id: 1, dependsOn: [2] }, { id: 2 }, { id: 3, dependsOn: [4] }, { id: 4, done: true }, { id: 5, openQuestions: [Q] }, { id: 6 },
  );
  assert.deepEqual([1, 3, 5, 6].map((i) => isBlocked(tasks[i], tasks)), [true, false, true, false]);
});

test('duplicate dependencies give one blocker', () => {
  const tasks = { ...tasksOf({ id: 2 }), 1: { ...newTask({ id: 1 }), dependsOn: [2, 2, 2] } };
  assert.deepEqual(blockers(tasks[1], tasks), [{ type: 'dependency', id: 2 }]);
});

test('readyQueue excludes blocked, backlog, in-progress, done tasks and epics', () => {
  const tasks = tasksOf(
    { id: 1 }, { id: 2, dependsOn: [1] }, { id: 3, approved: false }, { id: 4, assignee: 'a1' },
    { id: 5, done: true }, { id: 6, kind: 'epic' }, { id: 7, kind: 'epic', dependsOn: [1] },
  );
  assert.deepEqual(readyQueue(tasks).map((t) => t.id), [1]);
  assert.equal(columnOf(tasks[7], tasks), null);
});

test('an empty-string assignee counts as unassigned', () => {
  const tasks = { 1: { ...newTask({ id: 1 }), assignee: '' } };
  assert.equal(columnOf(tasks[1], tasks), 'ready');
});

test('wouldCycle on existing cycles and a diamond; huge dependency lists do not overflow', () => {
  const cyc = tasksOf({ id: 1, dependsOn: [2] }, { id: 2, dependsOn: [1] }, { id: 3 });
  assert.equal(wouldCycle(cyc, 3, 1), false);
  assert.equal(wouldCycle(cyc, 1, 2), true);
  const diamond = tasksOf({ id: 1, dependsOn: [2, 3] }, { id: 2, dependsOn: [4] }, { id: 3, dependsOn: [4] }, { id: 4 });
  assert.equal(wouldCycle(diamond, 4, 1), true);
  assert.equal(wouldCycle(diamond, 1, 4), false);
  const big = { 1: { ...newTask({ id: 1 }), dependsOn: Array.from({ length: 200000 }, (_, i) => i + 10) } };
  assert.equal(wouldCycle(big, 5, 1), false);
  assert.equal(wouldCycle(big, 199999, 1), true);
});

test('COLUMNS and COLUMN_LABELS are frozen', () => {
  assert.equal(Object.isFrozen(COLUMNS), true);
  assert.equal(Object.isFrozen(COLUMN_LABELS), true);
});
