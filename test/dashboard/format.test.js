import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo, duration, ordinal, joinIds, plural, metaText, askLine } from '../../src/dashboard/ui/format.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('timeAgo and duration', () => {
  assert.equal(timeAgo(0), 'just now');
  assert.equal(timeAgo(59_000), 'just now');
  assert.equal(timeAgo(5 * MIN), '5 min ago');
  assert.equal(timeAgo(3 * HOUR + 10 * MIN), '3 h ago');
  assert.equal(timeAgo(49 * HOUR), '2 d ago');
  assert.equal(timeAgo(-5 * MIN), 'just now'); // clock skew never shows the future
  assert.equal(duration(40 * MIN), '40 min');
  assert.equal(duration(20 * HOUR), '20 h');
  assert.equal(duration(30_000), '1 min');
});

test('ordinal, joinIds and plural', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  assert.equal(joinIds([21]), '#21');
  assert.equal(joinIds([21, 25]), '#21 and #25');
  assert.equal(joinIds([21, 25, 30]), '#21, #25 and #30');
  assert.equal(plural(1, 'agent'), '1 agent');
  assert.equal(plural(3, 'agent'), '3 agents');
});

test('metaText renders the card meta of each column (spec section 13 Board)', () => {
  const now = 10 * HOUR;
  assert.equal(metaText({ kind: 'origin', suggestedBy: 'Amber' }, now), 'suggested by Amber');
  assert.equal(metaText({ kind: 'origin', suggestedBy: null }, now), 'created by you');
  assert.equal(metaText({ kind: 'queue', position: 1 }, now), '1st in line');
  assert.equal(metaText({ kind: 'progress', checklist: { done: 3, total: 5 }, lastActivityAt: now - 12 * MIN }, now), '3/5 · 12 min');
  assert.equal(metaText({ kind: 'progress', checklist: null, lastActivityAt: now - 12 * MIN }, now), '12 min');
  assert.equal(metaText({ kind: 'waits', id: 12, backTo: 'Ready' }, now), 'back to Ready when #12 closes');
  assert.equal(metaText({ kind: 'done', at: now - 2 * HOUR }, now), '2 h ago');
  assert.equal(metaText(null, now), '');
});

test('askLine builds the ready-to-copy requests of Needs you', () => {
  assert.equal(askLine({ kind: 'question', taskId: 14 }), 'answer #14: ');
  assert.equal(askLine({ kind: 'approve', ids: [21, 25] }), 'approve #21 and #25');
  assert.equal(askLine({ kind: 'stalled', id: 9 }), 'resume #9');
});
