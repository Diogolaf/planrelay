import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBoard, readState, readRegistry } from '../../src/core/store.js';
import { columnOf } from '../../src/core/derive.js';
import { buildRecipesBoard, FIXTURE_IDS } from '../fixtures/recipes-app.js';
import { MIN, tempRepo } from '../helpers.js';

test('the recipes-app fixture has every dashboard situation', () => {
  const repo = tempRepo();
  const now = Date.UTC(2026, 8, 30, 15, 0);
  buildRecipesBoard(repo, { now });
  const board = openBoard(repo);
  const state = readState(board);
  const reg = readRegistry(board);
  const col = (id) => columnOf(state.tasks[id], state.tasks);
  assert.equal(col(FIXTURE_IDS.vegetarian), 'in_progress');
  assert.equal(col(FIXTURE_IDS.prepTime), 'blocked'); // question to the human
  assert.equal(col(FIXTURE_IDS.pagination), 'blocked'); // dependency
  assert.equal(col(FIXTURE_IDS.cachePhotos), 'backlog'); // suggestion
  assert.equal(col(FIXTURE_IDS.darkMode), 'backlog'); // suggestion
  assert.equal(col(FIXTURE_IDS.passwordReset), 'ready');
  assert.equal(col(FIXTURE_IDS.byIngredient), 'done');
  assert.equal(col(FIXTURE_IDS.rounding), 'done');
  assert.equal(state.tasks[FIXTURE_IDS.photoUpload].assignee !== null, true); // held by an ended session
  const names = Object.values(reg.agents).map((a) => a.name).sort();
  assert.deepEqual(names, ['Amber', 'Cobalt', 'Jade']);
  assert.ok(Object.values(reg.agents).some((a) => a.endedAt != null)); // Cobalt's session ended
  assert.ok(Object.values(state.tasks).every((t) => (t.updatedAt ?? 0) <= now));
});

test('the fixture keeps its ids, names and story', () => {
  const repo = tempRepo();
  const now = Date.UTC(2026, 8, 30, 15, 0);
  buildRecipesBoard(repo, { now });
  const board = openBoard(repo);
  const state = readState(board);
  const reg = readRegistry(board);
  const task = (id) => state.tasks[id];
  const agent = (name) => Object.values(reg.agents).find((a) => a.name === name);
  const ids = Object.values(FIXTURE_IDS);
  assert.deepEqual(Object.keys(state.tasks).map(Number).sort((a, b) => a - b), ids);
  assert.equal(task(FIXTURE_IDS.vegetarian).title, 'Vegetarian filter');
  assert.equal(task(FIXTURE_IDS.filters).parent, FIXTURE_IDS.search); // a sub-epic
  // palette order: the first registered is Amber, then Jade, then Cobalt
  const byFirstSeen = Object.values(reg.agents).sort((a, b) => a.firstSeen - b.firstSeen).map((a) => a.name);
  assert.deepEqual(byFirstSeen, ['Amber', 'Jade', 'Cobalt']);
  const [amber, jade, cobalt] = ['Amber', 'Jade', 'Cobalt'].map(agent);
  // Amber holds #5 with 3 of 5 checklist items done and a last edited file
  assert.equal(task(FIXTURE_IDS.vegetarian).assignee, amber.id);
  const checklist = task(FIXTURE_IDS.vegetarian).checklist;
  assert.deepEqual([checklist.filter((i) => i.done).length, checklist.length], [3, 5]);
  assert.equal(amber.lastFile, 'src/filters/diet.js');
  assert.ok(amber.lastFileAt <= now);
  assert.deepEqual(task(FIXTURE_IDS.vegetarian).files.map((f) => f.path), ['src/filters/diet.js']);
  // Jade holds #6 and asked the human
  assert.equal(task(FIXTURE_IDS.prepTime).assignee, jade.id);
  assert.deepEqual(task(FIXTURE_IDS.prepTime).openQuestions.map((q) => q.to), ['human']);
  // Cobalt's session ended while it still holds #9
  assert.equal(task(FIXTURE_IDS.photoUpload).assignee, cobalt.id);
  assert.deepEqual([task(FIXTURE_IDS.photoUpload).lastHandoff.kind, task(FIXTURE_IDS.photoUpload).lastHandoff.author], ['handoff', cobalt.id]);
  assert.notEqual(cobalt.endedAt, null);
  assert.equal(amber.endedAt, null);
  assert.equal(jade.endedAt, null);
  // the dependency, the suggestions and the done work
  assert.deepEqual(task(FIXTURE_IDS.pagination).dependsOn, [FIXTURE_IDS.vegetarian]);
  const suggested = Object.values(state.tasks).filter((t) => t.origin === 'agent' && !t.approved).map((t) => t.id);
  assert.deepEqual(suggested, [FIXTURE_IDS.cachePhotos, FIXTURE_IDS.darkMode]);
  const done = Object.values(state.tasks).filter((t) => t.done).map((t) => t.id);
  assert.deepEqual(done, [FIXTURE_IDS.byIngredient, FIXTURE_IDS.rounding]);
  // times run from about 90 min before now to 2 min before it
  const times = [
    ...Object.values(state.tasks).flatMap((t) => [t.createdAt, t.updatedAt]),
    ...Object.values(reg.agents).flatMap((a) => [a.firstSeen, a.lastSeen]),
  ];
  assert.ok(times.every((at) => at >= now - 90 * MIN && at <= now - 2 * MIN), 'every time within [now - 90 min, now - 2 min]');
  assert.equal(Math.max(amber.lastSeen, jade.lastSeen), now - 2 * MIN);
});
