import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { emptyState, newTask } from '../../src/core/reduce.js';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent, endAgent } from '../../src/core/agents.js';
import {
  maintenance, inheritClaim, systemMessage, lastActivity, folderMissing, MISSING_GRACE_MS,
} from '../../src/core/maintenance.js';
import { T0, MIN, HOUR, tempDir } from '../helpers.js';

const HERE = 'win32:box-a:';
const THERE = 'linux:box-a:Ubuntu';
const DAY = 24 * HOUR;
// Absolute on every platform: path.resolve gives a drive-qualified path on Windows.
const A = path.resolve('/w/a');
const B = path.resolve('/w/b');

/** io for the writer on HERE: `gone` folders are confirmed missing, `dead` pids do not run. */
const io = ({ gone = [], dead = [], host = HERE } = {}) => ({
  host, missing: (p) => gone.includes(p), alive: (pid) => !dead.includes(pid),
});

/** s1 (Amber) on HERE holds task 1 in folder A. */
function setup({ host = HERE } = {}) {
  const state = emptyState();
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: A, pid: 1, host }, T0);
  state.tasks[1] = newTask({ id: 1, title: 'One', assignee: 's1', claim: { folder: A, since: T0 }, createdAt: T0, updatedAt: T0 });
  return { state, reg };
}

/** s1 goes idle: seen 20 minutes before `now`. */
const idleAt = (reg, now) => { reg.agents.s1.lastSeen = now - 20 * MIN; };

test('a fresh claim is left alone', () => {
  const { state, reg } = setup();
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR, io()), []);
});

test('a removed folder releases the claim only after 10 minutes missing, addressed to the holder', () => {
  const { state, reg } = setup();
  const gone = io({ gone: [A] });
  idleAt(reg, T0 + HOUR);
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR, gone), []); // first sighting
  assert.deepEqual(reg.missing['1'], { agent: 's1', folder: A, at: T0 + HOUR });
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR + 9 * MIN, gone), []);
  const events = maintenance(state, reg, DEFAULTS, T0 + HOUR + MISSING_GRACE_MS, gone);
  assert.deepEqual(events.map((e) => e.type), ['message.posted', 'task.released']);
  assert.equal(events[0].data.message.text, "Released Amber's claim: the working folder was removed.");
  assert.equal(events[0].data.message.to, 's1');
  assert.equal(events[0].data.message.author, 'system');
  assert.deepEqual(events[1].data, { id: 1, reason: 'folder-missing' });
  assert.equal(reg.missing['1'], undefined);
});

test('a folder that comes back clears the sighting, and the 10 minutes start again', () => {
  const { state, reg } = setup();
  idleAt(reg, T0 + HOUR);
  maintenance(state, reg, DEFAULTS, T0 + HOUR, io({ gone: [A] }));
  maintenance(state, reg, DEFAULTS, T0 + HOUR + 5 * MIN, io());
  assert.equal(reg.missing['1'], undefined);
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR + 6 * MIN, io({ gone: [A] })), []);
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR + 12 * MIN, io({ gone: [A] })), []);
  assert.equal(maintenance(state, reg, DEFAULTS, T0 + HOUR + 16 * MIN, io({ gone: [A] })).length, 2);
});

test('an active owner keeps its claim while its folder is missing', () => {
  const { state, reg } = setup();
  const gone = io({ gone: [A] });
  maintenance(state, reg, DEFAULTS, T0 + MIN, gone);
  reg.agents.s1.lastSeen = T0 + 20 * MIN; // still working
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + 21 * MIN, gone), []);
  assert.ok(reg.missing['1']); // the first sighting is kept
  // once idle, the claim goes
  assert.equal(maintenance(state, reg, DEFAULTS, T0 + 36 * MIN, gone).length, 2);
});

test('a claim whose owner is on another host is never released by folder or pid checks', () => {
  const { state, reg } = setup({ host: THERE });
  const writer = io({ gone: [A], dead: [1] });
  for (let m = 0; m <= 60; m += 5) assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + m * MIN, writer), []);
  assert.equal(reg.agents.s1.endedAt, null);
  assert.deepEqual(reg.missing, {});
  // an owner without a recorded host (an older registry) is not judged either
  const old = setup({ host: null });
  assert.deepEqual(maintenance(old.state, old.reg, DEFAULTS, T0 + HOUR, writer), []);
  assert.equal(old.reg.agents.s1.endedAt, null);
  // an owner the registry no longer knows
  delete old.reg.agents.s1;
  assert.deepEqual(maintenance(old.state, old.reg, DEFAULTS, T0 + 2 * HOUR, writer), []);
});

test('the other host still ends its agents and claims after claimTimeoutHours', () => {
  const { state, reg } = setup({ host: THERE });
  const events = maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  assert.equal(reg.agents.s1.endedAt, T0 + 25 * HOUR);
  assert.equal(events[1].data.reason, 'timeout');
});

test('a folder that cannot be read is not missing: only ENOENT and ENOTDIR count', (t) => {
  const dir = tempDir();
  try {
    assert.equal(folderMissing(dir), false);
    assert.equal(folderMissing(path.join(dir, 'nope')), true);
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    assert.equal(folderMissing(path.join(dir, 'file', 'below')), true); // ENOTDIR on POSIX, ENOENT on Windows
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ETIMEDOUT', 'EBUSY']) {
      t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error(code), { code }); });
      assert.equal(folderMissing(path.join(dir, 'nope')), false, code);
      t.mock.restoreAll();
    }
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing folder counts only while a folder above it exists (the drive or share is there)', (t) => {
  const root = path.parse(path.resolve('/')).root;
  const deep = path.join(root, 'srv', 'work', 'repo');
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  /** stat: `exists` paths exist, `codes` maps a path to its error, anything else is ENOENT. */
  const fakeStat = (exists, codes = {}) => (p) => (exists.includes(p) ? {} : fail(codes[p] ?? 'ENOENT'));
  try {
    t.mock.method(fs, 'statSync', fakeStat([path.join(root, 'srv')]));
    assert.equal(folderMissing(deep), true); // the parent is gone too, but /srv is there
    t.mock.restoreAll();
    t.mock.method(fs, 'statSync', fakeStat([], { [deep]: 'ENOTDIR' }));
    assert.equal(folderMissing(deep), false); // nothing up to the root: an unplugged drive, an unreachable share
    t.mock.restoreAll();
    t.mock.method(fs, 'statSync', fakeStat([root], { [path.join(root, 'srv', 'work')]: 'EACCES' }));
    assert.equal(folderMissing(deep), false); // an unreadable folder on the way proves nothing
  } finally {
    t.mock.restoreAll();
  }
});

test('Windows: a folder on a drive letter that is not mapped is not missing', { skip: process.platform !== 'win32' }, () => {
  const letter = 'KLMNOPQRSTUVWXYZ'.split('').find((l) => !fs.existsSync(`${l}:\\`));
  if (!letter) return;
  assert.equal(folderMissing(`${letter}:\\work\\repo`), false);
});

test('an unreadable claim folder never releases a claim (default check)', (t) => {
  const { state, reg } = setup();
  idleAt(reg, T0 + HOUR);
  t.mock.method(fs, 'statSync', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
  try {
    for (let m = 0; m <= 30; m += 5) {
      assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + HOUR + m * MIN, { host: HERE, alive: () => true }), []);
    }
    assert.deepEqual(reg.missing, {});
  } finally {
    t.mock.restoreAll();
  }
});

test('a relative claim folder is never checked', () => {
  const { state, reg } = setup();
  state.tasks[1].claim.folder = 'relative/a';
  idleAt(reg, T0 + HOUR);
  let calls = 0;
  const writer = { host: HERE, alive: () => true, missing: () => (calls++, true) };
  maintenance(state, reg, DEFAULTS, T0 + HOUR, writer);
  maintenance(state, reg, DEFAULTS, T0 + 2 * HOUR, writer);
  assert.equal(calls, 0);
});

test('the file-system sweep runs at most once a minute', () => {
  const { state, reg } = setup();
  let calls = 0;
  const writer = { host: HERE, alive: () => true, missing: () => (calls++, false) };
  maintenance(state, reg, DEFAULTS, T0 + MIN, writer);
  assert.equal(reg.sweptAt, T0 + MIN);
  maintenance(state, reg, DEFAULTS, T0 + MIN + 59_999, writer);
  assert.equal(calls, 1);
  assert.equal(reg.sweptAt, T0 + MIN);
  maintenance(state, reg, DEFAULTS, T0 + 2 * MIN, writer);
  assert.equal(calls, 2);
  reg.sweptAt = T0 + DAY; // a sweep time in the future never blocks the sweep
  maintenance(state, reg, DEFAULTS, T0 + 3 * MIN, writer);
  assert.equal(calls, 3);
  reg.sweptAt = 'garbage';
  maintenance(state, reg, DEFAULTS, T0 + 3 * MIN + 1, writer);
  assert.equal(calls, 4);
});

test('a changed claim forgets the missing-folder sighting', () => {
  const { state, reg } = setup();
  idleAt(reg, T0 + HOUR);
  maintenance(state, reg, DEFAULTS, T0 + HOUR, io({ gone: [A] }));
  assert.ok(reg.missing['1']);
  touchAgent(reg, { id: 's2', folder: B, host: HERE }, T0 + HOUR);
  state.tasks[1].assignee = 's2';
  state.tasks[1].claim = { folder: A, since: T0 + HOUR };
  maintenance(state, reg, DEFAULTS, T0 + HOUR + 30_000, io()); // throttled: no sweep, but the claim changed
  assert.equal(reg.missing['1'], undefined);
  reg.missing['7'] = { agent: 's1', folder: A, at: T0 }; // no such task
  reg.missing['__proto__'] = { agent: 's1', folder: A, at: T0 };
  maintenance(state, reg, DEFAULTS, T0 + HOUR + 40_000, io());
  assert.deepEqual(Object.keys(reg.missing), []);
  reg.missing = 'garbage';
  maintenance(state, reg, DEFAULTS, T0 + HOUR + 50_000, io());
  assert.deepEqual(reg.missing, {});
});

test('a claim without activity for claimTimeoutHours is released, addressed to its holder', () => {
  const { state, reg } = setup();
  const events = maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  assert.equal(events[1].data.reason, 'timeout');
  assert.equal(events[0].data.message.text, "Released Amber's claim after 24 h without activity.");
  assert.equal(events[0].data.message.to, 's1');
  const again = setup();
  again.reg.activity[1] = T0 + 20 * HOUR;
  assert.deepEqual(maintenance(again.state, again.reg, DEFAULTS, T0 + 25 * HOUR, io()), []);
});

test('a release names a holder the registry forgot as an earlier agent', () => {
  const { state, reg } = setup();
  delete reg.agents.s1;
  const events = maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  assert.equal(events[0].data.message.text, "Released an earlier agent's claim after 24 h without activity.");
  assert.equal(events[0].data.message.to, 's1');
});

test('sessions whose host process died are ended, on this host only, for real pids only', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 'far', pid: 2, host: THERE }, T0);
  touchAgent(reg, { id: 'nopid', host: HERE }, T0);
  touchAgent(reg, { id: 'zero', pid: 0, host: HERE }, T0);
  touchAgent(reg, { id: 'neg', pid: -1, host: HERE }, T0);
  touchAgent(reg, { id: 'frac', pid: 3.5, host: HERE }, T0);
  const asked = [];
  maintenance(state, reg, DEFAULTS, T0 + MIN, { host: HERE, missing: () => false, alive: (pid) => (asked.push(pid), false) });
  assert.deepEqual(asked, [1]);
  assert.equal(reg.agents.s1.endedAt, T0 + MIN);
  for (const id of ['far', 'nopid', 'zero', 'neg', 'frac']) assert.equal(reg.agents[id].endedAt, null, id);
});

test('an agent without activity for claimTimeoutHours is ended, on any host', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 'far', host: THERE }, T0);
  touchAgent(reg, { id: 'recent', host: THERE }, T0 + 2 * HOUR);
  maintenance(state, reg, DEFAULTS, T0 + 24 * HOUR, io());
  assert.equal(reg.agents.far.endedAt, null); // exactly claimTimeoutHours: not yet
  maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  assert.equal(reg.agents.far.endedAt, T0 + 25 * HOUR);
  assert.equal(reg.agents.s1.endedAt, T0 + 25 * HOUR);
  assert.equal(reg.agents.recent.endedAt, null);
  // no usable time at all: ended too (a touch revives it)
  touchAgent(reg, { id: 'corrupt' }, T0 + 25 * HOUR);
  reg.agents.corrupt.lastSeen = 'x';
  reg.agents.corrupt.firstSeen = null;
  maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR + 1, io());
  assert.equal(reg.agents.corrupt.endedAt, T0 + 25 * HOUR + 1);
});

test('lastActivity: the latest usable time, then the task times, never permanent', () => {
  const { state, reg } = setup();
  const t = state.tasks[1];
  assert.equal(lastActivity(t, reg), T0);
  reg.activity[1] = T0 + HOUR;
  assert.equal(lastActivity(t, reg), T0 + HOUR);
  reg.agents.s1.lastSeen = T0 + 2 * HOUR;
  assert.equal(lastActivity(t, reg), T0 + 2 * HOUR);
  // corrupt: no usable claim, activity or owner time
  delete reg.activity[1];
  reg.agents.s1.lastSeen = Number.NaN;
  t.claim.since = 'garbage';
  t.updatedAt = T0 + 3 * HOUR;
  assert.equal(lastActivity(t, reg), T0 + 3 * HOUR);
  t.updatedAt = null;
  assert.equal(lastActivity(t, reg), T0);
  t.createdAt = null;
  assert.equal(lastActivity(t, reg), 0);
  // so such a claim still times out
  assert.equal(maintenance(state, reg, DEFAULTS, T0, io())[1].data.reason, 'timeout');
});

test('a claim with a corrupt since is not released instantly', () => {
  const { state, reg } = setup();
  state.tasks[1].claim.since = 'garbage';
  reg.agents.s1.lastSeen = T0 + HOUR;
  assert.deepEqual(maintenance(state, reg, DEFAULTS, T0 + 2 * HOUR, io()), []);
});

test('systemMessage: extra fields never replace the task, author, kind or text', () => {
  const ev = systemMessage(3, 'Hello.', { to: 's1', taskId: 9, author: 's2', kind: 'answer', text: 'Other.' });
  assert.equal(ev.actor, 'system');
  assert.deepEqual(ev.data.message, { mentions: [], to: 's1', taskId: 3, author: 'system', authorName: 'system', kind: 'system', text: 'Hello.' });
});

test('old ended agents without claims, stale touches and finished activity are pruned', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 'old' }, T0);
  endAgent(reg, 'old', T0);
  reg.touches['src/a.js'] = { agent: 's1', task: 1, at: T0 };
  reg.activity[1] = T0;
  reg.activity[9] = T0;
  reg.activity[1] = T0 + 8 * 24 * HOUR;
  maintenance(state, reg, DEFAULTS, T0 + 8 * 24 * HOUR, io());
  assert.equal(reg.agents.old, undefined);
  assert.ok(reg.agents.s1);
  assert.deepEqual(reg.touches, {});
  assert.deepEqual(Object.keys(reg.activity), ['1']);
});

test('touches with a time that is not usable or far ahead are pruned; malformed ones never throw', () => {
  const { state, reg } = setup();
  const now = T0 + MIN;
  reg.touches['src/ok.js'] = { agent: 's1', task: 1, at: T0 };
  reg.touches['src/soon.js'] = { agent: 's1', task: 1, at: now + 29 * MIN }; // within lockMinutes ahead: kept
  reg.touches['src/ahead.js'] = { agent: 's1', task: 1, at: now + 31 * MIN };
  reg.touches['src/nan.js'] = { agent: 's1', task: 1, at: 'x' };
  reg.touches['src/null.js'] = null;
  reg.touches['src/none.js'] = { agent: 's1', task: 1 };
  maintenance(state, reg, DEFAULTS, now, io());
  assert.deepEqual(Object.keys(reg.touches).sort(), ['src/ok.js', 'src/soon.js']);
});

test('a new session inherits a claim left in its folder by a gone agent', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 's2', folder: A }, T0 + MIN); // registered while Amber is live, so it is Jade
  endAgent(reg, 's1', T0 + 2 * MIN);
  const events = inheritClaim(state, reg, 's2', A);
  assert.deepEqual(events.map((e) => e.type), ['message.posted', 'task.claimed']);
  assert.equal(events[0].data.message.text, 'Jade continues this task in the same folder (taken over from Amber).');
  assert.deepEqual(events[1].data, { id: 1, agent: 's2', agentName: 'Jade', folder: A });
});

test('a successor that reused the same name gets a plain continuation message', () => {
  const { state, reg } = setup();
  endAgent(reg, 's1', T0 + MIN);
  touchAgent(reg, { id: 's2', folder: A }, T0 + 2 * MIN); // "Amber" carries over in the same folder
  assert.equal(inheritClaim(state, reg, 's2', A)[0].data.message.text, 'Amber continues this task in a new session.');
});

test('inheritance takes the claim of the gone owner seen last', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 's3', folder: A }, T0 + MIN);
  state.tasks[2] = newTask({ id: 2, assignee: 's3', claim: { folder: A, since: T0 + MIN } });
  endAgent(reg, 's1', T0 + 2 * MIN);
  endAgent(reg, 's3', T0 + 2 * MIN);
  touchAgent(reg, { id: 's2', folder: A }, T0 + 3 * MIN);
  assert.equal(inheritClaim(state, reg, 's2', A)[1].data.id, 2);
});

test('no inheritance from a live agent, another folder, or when already holding a claim', () => {
  const { state, reg } = setup();
  touchAgent(reg, { id: 's2', folder: A }, T0);
  assert.deepEqual(inheritClaim(state, reg, 's2', A), []);
  endAgent(reg, 's1', T0);
  assert.deepEqual(inheritClaim(state, reg, 's2', B), []);
  state.tasks[2] = newTask({ id: 2, assignee: 's2', claim: { folder: A, since: T0 } });
  assert.deepEqual(inheritClaim(state, reg, 's2', A), []);
});

test('folderMissing: a path that is not absolute is never missing', () => {
  assert.equal(folderMissing('no/such/relative/folder'), false);
  assert.equal(folderMissing(''), false);
  assert.equal(folderMissing('.'), false);
});

test('system messages made by maintenance carry the author name "system"', () => {
  const { state, reg } = setup();
  const events = maintenance(state, reg, DEFAULTS, T0 + 25 * HOUR, io());
  const note = events.find((e) => e.type === 'message.posted');
  assert.equal(note.data.message.authorName, 'system');
});
