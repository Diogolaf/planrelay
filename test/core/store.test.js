import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  openBoard, transact, readState, readMessages, readRegistry, repair, replay, messagesFile, logHealth,
} from '../../src/core/store.js';
import { samePath } from '../../src/core/paths.js';
import { PALETTE, touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { maintenance } from '../../src/core/maintenance.js';
import { claimTask } from '../../src/core/ops.js';
import { whatsNew } from '../../src/core/queries.js';
import { SCHEMA } from '../../src/core/reduce.js';
import { tempRepo, T0, MIN, HOUR } from '../helpers.js';

const createEv = (id, title = `Task ${id}`) => ({
  type: 'task.created', actor: 'a1',
  data: { task: { id, kind: 'task', title, origin: 'human', createdBy: 'human', approved: true, rank: id } },
});
const post = (taskId, text, kind = 'comment', extra = {}) => ({
  type: 'message.posted', actor: 'a1', data: { message: { taskId, author: 'a1', kind, text, mentions: [], ...extra } },
});
const logLines = (b) => fs.readFileSync(b.files.events, 'utf8').trim().split('\n');

/** A small seeded random generator (mulberry32), so the property test is repeatable. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('openBoard points into the git directory', () => {
  const repo = tempRepo();
  const b = openBoard(repo);
  assert.ok(samePath(b.dir, path.join(repo, '.git', 'agentboard')));
  assert.equal(b.config.maxPings, 8);
});

test('transact stamps, appends, applies and snapshots', () => {
  const b = openBoard(tempRepo());
  const out = transact(b, (s) => ({ events: [createEv(s.nextId)], result: 'ok' }), { now: T0 });
  assert.equal(out.result, 'ok');
  assert.equal(out.events[0].seq, 1);
  assert.equal(out.events[0].at, T0);
  assert.deepEqual(out.degraded, []);
  assert.equal(readState(b).tasks[1].title, 'Task 1');
  assert.equal(logLines(b).length, 1);
});

test('every event of one write carries its batch: tx is the first seq, n the size', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const out = transact(b, () => ({ events: [createEv(2), createEv(3), post(2, 'x')] }));
  assert.deepEqual(out.events.map((e) => [e.seq, e.tx, e.n]), [[2, 2, 3], [3, 2, 3], [4, 2, 3]]);
  assert.deepEqual(logLines(b).map((l) => JSON.parse(l)).map((e) => [e.seq, e.tx, e.n]), [[1, 1, 1], [2, 2, 3], [3, 2, 3], [4, 2, 3]]);
});

test('transact stamps each event with its actor display name', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  transact(board, (state, reg, t) => {
    touchAgent(reg, { id: 'a1', folder: repo, seq: state.seq }, t);
    return { registry: reg, events: [
      { type: 'task.created', actor: 'a1', data: { task: { id: 1, kind: 'task', title: 'T', origin: 'agent', createdBy: 'a1', approved: false, rank: 1 } } },
      { type: 'task.released', actor: 'system', data: { id: 1, reason: 'timeout' } },
    ] };
  }, { now: T0 });
  const lines = logLines(board).map((l) => JSON.parse(l));
  assert.equal(lines[0].actorName, 'Amber');
  assert.equal(lines[1].actorName, null);
  assert.deepEqual(readState(board).recent.map((r) => r.actorName), ['Amber', null]);
});

test('messages get ids and land in their task file', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const out = transact(b, () => ({ events: [post(1, 'hi')] }), { now: T0 });
  assert.equal(out.events[0].data.message.id, 'm2');
  assert.equal(out.events[0].data.message.at, T0);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
  for (const id of [0, -1, 1.5, '1', null]) assert.deepEqual(readMessages(b, id), []);
  assert.throws(() => messagesFile(b, '../1'), TypeError);
});

test('a snapshot behind the log is detected and replayed', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.appendFileSync(b.files.events, JSON.stringify({ seq: 2, at: T0, ...createEv(2, 'Written behind the snapshot') }) + '\n');
  assert.equal(readState(b).tasks[2].title, 'Written behind the snapshot');
  transact(b, (s) => ({ events: [createEv(s.nextId)] }));
  assert.equal(readState(b).tasks[3].id, 3);
});

test('a corrupt snapshot is rebuilt from the log', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.writeFileSync(b.files.state, '{broken');
  assert.equal(readState(b).tasks[1].title, 'Task 1');
});

test('an unreadable or misshapen snapshot is rebuilt from the log', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const size = fs.statSync(b.files.events).size;
  fs.writeFileSync(b.files.state, JSON.stringify({ schema: SCHEMA, seq: 1, nextId: 2, eventsSize: size, tasks: null, recent: [], messages: [] }));
  assert.equal(readState(b).tasks[1].title, 'Task 1');
  fs.rmSync(b.files.state);
  fs.mkdirSync(b.files.state); // a folder where the snapshot should be
  assert.equal(readState(b).tasks[1].title, 'Task 1');
});

test('a snapshot of an older schema is not trusted: readers replay the log, and the next write saves the current shape', () => {
  const b = openBoard(tempRepo());
  transact(b, (s, reg, now) => {
    touchAgent(reg, { id: 'a1', seq: s.seq }, now);
    return { registry: reg, events: [createEv(1), post(1, 'Started on the filter.')] };
  });
  const snap = JSON.parse(fs.readFileSync(b.files.state, 'utf8'));
  assert.equal(snap.schema, SCHEMA);
  assert.equal(snap.eventsSize, fs.statSync(b.files.events).size);
  // as older schemas saved it, matching the log otherwise: activity entries without actorName (1 and 2),
  // message ring entries without their seq (1)
  const recent = snap.recent.map(({ actorName, ...r }) => r);
  for (const old of [{ ...snap, schema: 1, recent, messages: snap.messages.map(({ seq, ...m }) => m) }, { ...snap, schema: 2, recent }]) {
    fs.writeFileSync(b.files.state, JSON.stringify(old));
    const s = readState(b);
    assert.deepEqual(s.messages.map((m) => m.seq), [2]);
    assert.deepEqual(s.recent.map((r) => r.actorName), ['Amber']);
  }
  transact(b, () => ({ events: [post(1, 'Next: the screen.')] }));
  const saved = JSON.parse(fs.readFileSync(b.files.state, 'utf8'));
  assert.equal(saved.schema, SCHEMA);
  assert.deepEqual(saved.messages.map((m) => m.seq), [2, 3]);
  assert.deepEqual(saved.recent.map((r) => r.actorName), ['Amber']);
});

test('malformed and partial lines are skipped, and later appends stay intact', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.appendFileSync(b.files.events, '{"seq":2,"type":"task.cre'); // crash mid-write, no newline
  transact(b, (s) => ({ events: [createEv(s.nextId)] }));
  const { bad, state } = repair(b);
  assert.deepEqual(bad, [2]);
  assert.deepEqual(Object.keys(state.tasks), ['1', '2']);
});

test('lines that parse but are not events are skipped and reported', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.appendFileSync(b.files.events, 'null\n{"seq":3,"type":"message.posted"}\n');
  const { bad, state } = repair(b);
  assert.deepEqual(bad, [2]);
  assert.deepEqual(Object.keys(state.tasks), ['1']);
  assert.equal(readState(b).tasks[1].title, 'Task 1');
});

test('reported line numbers are the lines of the file, blank lines included', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.appendFileSync(b.files.events, '\n{broken\n');
  assert.deepEqual(repair(b).bad, [3]);
});

test('a torn batch at the end of the log is ignored and reported', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const torn = [2, 3].map((seq) => JSON.stringify({ seq, tx: 2, n: 3, at: T0, ...createEv(seq) }));
  fs.appendFileSync(b.files.events, torn.join('\n') + '\n'); // the batch's third event never arrived
  assert.deepEqual(Object.keys(readState(b).tasks), ['1']);
  assert.deepEqual(replay(b).bad, [2, 3]);
  assert.equal(transact(b, (s) => ({ events: [createEv(s.nextId)] })).events[0].seq, 2);
  const { bad, state } = repair(b);
  assert.deepEqual(bad, [2, 3]);
  assert.deepEqual(Object.keys(state.tasks), ['1', '2']);
  assert.deepStrictEqual(readState(b), replay(b, { messages: false }).state);
});

test('logHealth counts malformed lines but not a batch still being written at the end', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  assert.deepEqual(logHealth(board), { badLines: 0 }); // no log yet
  transact(board, () => ({ events: [{ type: 'task.created', actor: 'h', data: { task: { id: 1, kind: 'task', title: 'A', rank: 1 } } }] }), { now: T0 });
  assert.deepEqual(logHealth(board), { badLines: 0 });
  fs.appendFileSync(board.files.events, 'not json\n');
  assert.deepEqual(logHealth(board), { badLines: 1 });
  // the first line of a two-event batch whose second line has not arrived yet: still being written
  const approve = (seq, n) => `${JSON.stringify({ seq, tx: seq, n, at: T0, type: 'task.approved', actor: 'h', data: { id: 1, approved: true } })}\n`;
  fs.appendFileSync(board.files.events, approve(3, 2));
  assert.deepEqual(logHealth(board), { badLines: 1 });
  // a later write shows it was cut short (a crash): now it counts, like the other bad lines repair reports
  transact(board, () => ({ events: [{ type: 'task.approved', actor: 'h', data: { id: 1, approved: false } }] }), { now: T0 });
  assert.deepEqual(logHealth(board), { badLines: 2 });
  fs.appendFileSync(board.files.events, approve(3, 2));
  assert.deepEqual(logHealth(board), { badLines: 2 });
  assert.deepEqual(repair(board).bad, [2, 3, 5]);
});

test('a failed append is truncated back, so no part of the batch stays in the log', (t) => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const before = fs.readFileSync(b.files.events);
  const original = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, data, ...rest) => {
    if (file === b.files.events && String(data).length > 1) {
      original.call(fs, file, String(data).slice(0, Math.floor(String(data).length / 2)), ...rest); // half, then the disk is full
      throw Object.assign(new Error('no space left on device (test)'), { code: 'ENOSPC' });
    }
    return original.call(fs, file, data, ...rest);
  });
  assert.throws(() => transact(b, (s) => ({ events: [createEv(s.nextId), createEv(s.nextId + 1)] })), /no space left/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(b.files.events), before);
  assert.deepEqual(Object.keys(readState(b).tasks), ['1']);
  assert.equal(transact(b, (s) => ({ events: [createEv(s.nextId)] })).events[0].seq, 2);
  assert.deepEqual(repair(b).bad, []);
});

test('a log that grew under the lock is rebuilt and fn run again before appending (fence)', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1, 'one')] }));
  let calls = 0;
  const out = transact(b, (s) => {
    calls++;
    // Another holder of a lock taken over as stale appends with the same seq and the same new id.
    if (calls === 1) fs.appendFileSync(b.files.events, JSON.stringify({ seq: 2, at: T0, ...createEv(2, 'written by the other holder') }) + '\n');
    return { events: [createEv(s.nextId, 'written by this holder')], result: s.nextId };
  });
  assert.equal(calls, 2);
  assert.equal(out.result, 3);
  assert.equal(out.events[0].seq, 3);
  const s = readState(b);
  assert.equal(s.tasks[2].title, 'written by the other holder');
  assert.equal(s.tasks[3].title, 'written by this holder');
  assert.deepStrictEqual(s, replay(b, { messages: false }).state);
  assert.deepEqual(repair(b).bad, []);
  assert.match(fs.readFileSync(b.files.errors, 'utf8'), /fence/);
  // A log that keeps changing under the lock is refused rather than appended to.
  assert.throws(() => transact(b, (st) => {
    fs.appendFileSync(b.files.events, '{"not":"an event"}\n');
    return { events: [createEv(st.nextId, 'never written')] };
  }), /keeps changing/);
  assert.ok(!fs.readFileSync(b.files.events, 'utf8').includes('never written'));
});

test('readers catch up from the log tail, exactly like a full replay', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1), createEv(2)] }));
  transact(b, () => ({ events: [post(1, 'first')] }));
  const size = fs.statSync(b.files.events).size; // the snapshot covers exactly this much
  const line = (o) => JSON.stringify(o) + '\n';
  fs.appendFileSync(b.files.events,
    line({ seq: 4, tx: 4, n: 2, at: T0, ...createEv(3) })
    + line({ seq: 5, tx: 4, n: 2, at: T0, type: 'task.claimed', actor: 'a2', data: { id: 3, agent: 'a2', folder: null } })
    + line({ seq: 5, tx: 5, n: 2, at: T0, ...createEv(8) }) // a batch that repeats seq 5: all of it is skipped,
    + line({ seq: 6, tx: 5, n: 2, at: T0, ...createEv(9) }) // even its event with a new seq
    + '{broken\n'
    + line({ seq: 6, at: T0, ...post(3, 'q', 'question', { id: 'm6' }) })
    + line({ seq: 7, tx: 7, n: 2, at: T0, ...createEv(7) })); // a batch still being written
  const caught = readState(b);
  assert.equal(caught.tasks[3].assignee, 'a2');
  assert.equal(caught.tasks[3].openQuestions.length, 1);
  for (const id of [7, 8, 9]) assert.equal(caught.tasks[id], undefined);
  assert.deepStrictEqual(caught, replay(b, { messages: false }).state);
  assert.deepEqual(replay(b).bad, [6, 7, 8, 10]);
  // Only the tail was read: a same-length change inside the part the snapshot covers goes unseen.
  fs.writeFileSync(b.files.events, fs.readFileSync(b.files.events, 'utf8').replace('"Task 1"', '"Task X"'));
  assert.equal(readState(b).tasks[1].title, 'Task 1');
  assert.equal(replay(b).state.tasks[1].title, 'Task X');
  // A snapshot whose size is not a line boundary is not trusted: the whole log is replayed.
  const snap = JSON.parse(fs.readFileSync(b.files.state, 'utf8'));
  fs.writeFileSync(b.files.state, JSON.stringify({ ...snap, eventsSize: size - 2 }));
  assert.equal(readState(b).tasks[1].title, 'Task X');
});

test('a batch that straddles the snapshot is not caught up from the tail but replayed', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const [first, second] = [2, 3].map((seq) => JSON.stringify({ seq, tx: 2, n: 2, at: T0, ...createEv(seq) }) + '\n');
  fs.appendFileSync(b.files.events, first);
  repair(b); // the snapshot now covers the first half of the batch, which it could not apply
  fs.appendFileSync(b.files.events, second); // the batch is complete in the log
  assert.deepEqual(Object.keys(readState(b).tasks), ['1', '2', '3']);
  assert.deepStrictEqual(readState(b), replay(b, { messages: false }).state);
});

test('bad transact input is refused before anything is written', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const before = fs.readFileSync(b.files.events, 'utf8');
  assert.throws(() => transact(b, () => ({ events: [createEv(2), { actor: 'a1', data: {} }] })), /no string type/);
  assert.throws(() => transact(b, async () => ({ events: [createEv(2)] })), /must be synchronous/);
  assert.throws(() => transact(b, () => ({ events: createEv(2) })), /must be an array/);
  assert.throws(() => transact(b, () => ({ events: [createEv(2)], registry: new Map() })), /plain object/);
  assert.throws(() => transact(b, () => ({ events: [createEv(2)], registry: [] })), /plain object/);
  assert.throws(() => transact(b, () => ({ events: [createEv(2)] }), { before: 'maintenance' }), /before must be a function/);
  assert.throws(() => transact(b, () => ({ events: [createEv(2)] }), { before: () => createEv(3) }), /before events must be an array/);
  assert.throws(() => transact(b, () => ({ events: [createEv(2)] }), { before: async () => [] }), /before must be synchronous/);
  // A stamped event must be a valid event: here the next seq would not be a safe integer.
  const snap = JSON.parse(fs.readFileSync(b.files.state, 'utf8'));
  fs.writeFileSync(b.files.state, JSON.stringify({ ...snap, seq: Number.MAX_SAFE_INTEGER }));
  assert.throws(() => transact(b, () => ({ events: [createEv(2)] })), /not a valid event/);
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), before);
  assert.equal(fs.existsSync(b.files.agents), false);
});

test('the registry is written before the append, and a failed registry write commits nothing', (t) => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const before = fs.readFileSync(b.files.events, 'utf8');
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (String(file).startsWith(b.files.agents)) throw Object.assign(new Error('registry disk full (test)'), { code: 'ENOSPC' });
    return originalWrite.call(fs, file, ...rest);
  });
  assert.throws(() => transact(b, (s, reg) => ({ registry: reg })), /registry disk full/);
  assert.throws(() => transact(b, (s, reg) => ({ events: [createEv(2)], registry: reg })), /registry disk full/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), before);
  const originalAppend = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, ...rest) => {
    if (file === b.files.events) throw Object.assign(new Error('append failed (test)'), { code: 'EIO' });
    return originalAppend.call(fs, file, ...rest);
  });
  assert.throws(() => transact(b, (s, reg) => {
    reg.agents.z = { id: 'z' };
    return { events: [createEv(2)], registry: reg };
  }), /append failed/);
  t.mock.restoreAll();
  assert.equal(Object.hasOwn(readRegistry(b).agents, 'z'), false); // written first, then rolled back
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), before);
});

/** Makes every append to the board's event log fail; other appends (errors.log) go through. */
function failAppends(t, b) {
  const original = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, ...rest) => {
    if (file === b.files.events) throw Object.assign(new Error('append failed (test)'), { code: 'EIO' });
    return original.call(fs, file, ...rest);
  });
}

test('a failed append rolls the registry back to its exact previous content, so nothing in it is ahead of the log', (t) => {
  const b = openBoard(tempRepo());
  transact(b, (s, reg) => {
    reg.agents.a1 = { id: 'a1', name: 'Amber', cursor: 0 };
    return { events: [createEv(1)], registry: reg };
  });
  fs.appendFileSync(b.files.agents, '\n'); // byte for byte: even formatting this process would not write is kept
  const registryBefore = fs.readFileSync(b.files.agents);
  const logBefore = fs.readFileSync(b.files.events);
  failAppends(t, b);
  assert.throws(() => transact(b, (s, reg) => {
    reg.agents.a1.cursor = s.seq + 1; // as a hook advancing the cursor past this write's own events
    reg.agents.z = { id: 'z' };
    return { events: [createEv(2)], registry: reg };
  }, { before: (s, reg) => { reg.activity[1] = T0; } }), /^Error: append failed \(test\)$/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readFileSync(b.files.agents), registryBefore);
  assert.deepEqual(fs.readFileSync(b.files.events), logBefore);
  // a board that had no registry file before the failed write has none after it
  const fresh = openBoard(tempRepo());
  failAppends(t, fresh);
  assert.throws(() => transact(fresh, (s, reg) => ({ events: [createEv(1)], registry: reg })), /append failed/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(fresh.files.agents), false);
});

/**
 * Makes appends to the board's event log write `part` of the data (all, half or none) and then
 * throw, as an EIO reported at close would; truncating the log back fails too when `stuck` is true.
 */
function brokenAppends(t, b, { part, stuck }) {
  const original = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, data, ...rest) => {
    if (file !== b.files.events) return original.call(fs, file, data, ...rest);
    const text = String(data);
    const written = part === 'all' ? text : part === 'half' ? text.slice(0, Math.floor(text.length / 2)) : '';
    if (written) original.call(fs, file, written);
    throw Object.assign(new Error('EIO after write (test)'), { code: 'EIO' });
  });
  if (stuck) {
    const originalTruncate = fs.truncateSync;
    t.mock.method(fs, 'truncateSync', (file, ...rest) => {
      if (file === b.files.events) throw Object.assign(new Error('truncate failed (test)'), { code: 'EIO' });
      return originalTruncate.call(fs, file, ...rest);
    });
  }
}

test('the registry is restored only when the batch cannot have landed', (t) => {
  /** A board where #1 exists; then a session registers and claims it in one write that fails as given. */
  const attempt = (how) => {
    const b = openBoard(tempRepo());
    transact(b, (s, reg) => ({ events: [createEv(1)], registry: reg }), { now: T0 });
    const registryBefore = fs.readFileSync(b.files.agents);
    brokenAppends(t, b, how);
    assert.throws(() => transact(b, (s, reg) => {
      touchAgent(reg, { id: 'a9', folder: '/w/z', seq: s.seq }, T0);
      return { events: [{ type: 'task.claimed', actor: 'a9', data: { id: 1, agent: 'a9', agentName: 'Jade', folder: '/w/z' } }], registry: reg };
    }, { now: T0 }), /EIO after write \(test\)/);
    t.mock.restoreAll();
    return { restored: fs.readFileSync(b.files.agents).equals(registryBefore), known: Object.hasOwn(readRegistry(b).agents, 'a9'), holder: readState(b).tasks[1].assignee };
  };
  // the whole batch is in the log and stays there: it is committed, so the registry that goes with it is kept
  assert.deepEqual(attempt({ part: 'all', stuck: true }), { restored: false, known: true, holder: 'a9' });
  // the batch was written but truncated back, or never written: nothing landed, so the registry goes back
  assert.deepEqual(attempt({ part: 'all', stuck: false }), { restored: true, known: false, holder: null });
  assert.deepEqual(attempt({ part: 'none', stuck: true }), { restored: true, known: false, holder: null });
  // half the batch stays in the log: replay ignores a torn batch, so it cannot have landed either
  assert.deepEqual(attempt({ part: 'half', stuck: true }), { restored: true, known: false, holder: null });
});

test('when the log changed under the lock, the registry is restored and nothing is appended', (t) => {
  const b = openBoard(tempRepo());
  transact(b, (s, reg) => ({ events: [createEv(1)], registry: reg }), { now: T0 });
  const registryBefore = fs.readFileSync(b.files.agents);
  const sizeBefore = fs.statSync(b.files.events).size;
  // the line another writer slips in is exactly as long as this write's batch, so the log's size alone
  // would look as if the batch had landed: only "the append was never tried" tells them apart
  const batchBytes = Buffer.byteLength(JSON.stringify({ seq: 2, tx: 2, n: 1, at: T0, ...createEv(2) }) + '\n');
  const foreign = `${'x'.repeat(batchBytes - 1)}\n`;
  const originalWrite = fs.writeFileSync;
  let registryWrites = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    const out = originalWrite.call(fs, file, ...rest);
    if (String(file).startsWith(b.files.agents) && ++registryWrites === 1) fs.appendFileSync(b.files.events, foreign);
    return out;
  });
  assert.throws(() => transact(b, (s, reg) => {
    reg.agents.z = { id: 'z' };
    return { events: [createEv(2)], registry: reg };
  }, { now: T0 }), /the event log changed while this process held the lock/);
  t.mock.restoreAll();
  assert.equal(fs.statSync(b.files.events).size, sizeBefore + batchBytes);
  assert.deepEqual(fs.readFileSync(b.files.agents), registryBefore);
  assert.deepEqual(Object.keys(readState(b).tasks), ['1']);
});

test('if the registry cannot be restored, that is logged and the append error is still the one thrown', (t) => {
  const b = openBoard(tempRepo());
  transact(b, (s, reg) => ({ events: [createEv(1)], registry: reg }));
  failAppends(t, b);
  const originalWrite = fs.writeFileSync;
  let registryWrites = 0;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (String(file).startsWith(b.files.agents) && ++registryWrites > 1) {
      throw Object.assign(new Error('restore failed (test)'), { code: 'ENOSPC' });
    }
    return originalWrite.call(fs, file, ...rest);
  });
  assert.throws(() => transact(b, (s, reg) => ({ events: [createEv(2)], registry: reg })), /^Error: append failed \(test\)$/);
  t.mock.restoreAll();
  assert.equal(registryWrites, 2);
  assert.match(fs.readFileSync(b.files.errors, 'utf8'), /restoring the registry after a failed append: Error: restore failed \(test\)/);
});

test('after a failed prompt write, the next prompt still pings what housekeeping regenerates (the cursor was rolled back)', (t) => {
  const b = openBoard(tempRepo());
  const io = { host: 'test-host', missing: () => false, alive: () => true };
  // Amber registers and claims #1
  transact(b, (s, reg) => {
    touchAgent(reg, { id: 'a1', folder: '/w/a', seq: s.seq }, T0);
    return {
      events: [createEv(1), { type: 'task.claimed', actor: 'a1', data: { id: 1, agent: 'a1', agentName: 'Amber', folder: '/w/a' } }],
      registry: reg,
    };
  }, { now: T0 });
  /** A prompt as the hook runs it: housekeeping first, then pings since the cursor, then the cursor advances. */
  const prompt = (now) => transact(b, (s, reg) => {
    touchAgent(reg, { id: 'a1', seq: s.seq }, now);
    const agent = reg.agents.a1;
    const pings = whatsNew(s, reg, 'a1', { afterSeq: agent.cursor }).items.map((i) => i.message.text);
    agent.prevCursor = agent.cursor;
    agent.cursor = s.seq;
    return { registry: reg, result: pings };
  }, { now, before: (s, reg, at) => maintenance(s, reg, DEFAULTS, at, io) });
  // Amber comes back after claimTimeoutHours: housekeeping releases her claim, but the append fails
  failAppends(t, b);
  assert.throws(() => prompt(T0 + 25 * HOUR), /append failed/);
  t.mock.restoreAll();
  assert.equal(readRegistry(b).agents.a1.cursor, 0); // as registered, not advanced past the release that never landed
  // the next prompt: housekeeping writes the release again, under the same seqs, and Amber is told
  const out = prompt(T0 + 25 * HOUR + MIN);
  assert.deepEqual(out.result, ["Released Amber's claim after 24 h without activity."]);
  assert.equal(readState(b).tasks[1].assignee, null);
  assert.equal(readRegistry(b).agents.a1.cursor, out.state.seq);
});

test('a message file that cannot be written degrades writes but never blocks them', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.mkdirSync(messagesFile(b, 1), { recursive: true }); // a folder where task 1's message file belongs
  const first = transact(b, () => ({ events: [post(1, 'hi')], result: 'done' }));
  assert.equal(first.result, 'done');
  assert.deepEqual(first.degraded, ['messages', 'snapshot']);
  const second = transact(b, (s) => ({ events: [createEv(s.nextId)] })); // rebuilds, fails again, still commits
  assert.deepEqual(second.degraded, ['messages', 'snapshot']);
  const s = readState(b);
  assert.equal(s.tasks[1].messageCount, 1);
  assert.equal(s.tasks[2].id, 2);
  assert.deepStrictEqual(s, replay(b, { messages: false }).state);
  assert.match(fs.readFileSync(b.files.errors, 'utf8'), /after commit/);
  fs.rmSync(messagesFile(b, 1), { recursive: true });
  assert.deepEqual(transact(b, () => ({})).degraded, []); // the next write heals it
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
});

test('a snapshot that cannot be written degrades writes but never blocks them', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.rmSync(b.files.state);
  fs.mkdirSync(path.join(b.files.state, 'x'), { recursive: true }); // a folder where the snapshot belongs
  for (let i = 0; i < 2; i++) {
    const out = transact(b, (s) => ({ events: [createEv(s.nextId), post(1, `note ${i}`)] }));
    assert.deepEqual(out.degraded, ['snapshot']);
  }
  const s = readState(b);
  assert.deepEqual(Object.keys(s.tasks), ['1', '2', '3']);
  assert.deepStrictEqual(s, replay(b, { messages: false }).state);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['note 0', 'note 1']);
});

test('repair is strict, and removes temp files left by crashed writers', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1), post(1, 'hi')] }));
  const leftovers = [
    path.join(b.dir, 'agents.json.123.abc.tmp'),
    path.join(path.dirname(b.files.state), 'board.json.123.abc.tmp'),
    path.join(b.files.messagesDir, '1.jsonl.123.abc.tmp'),
  ];
  for (const f of leftovers) fs.writeFileSync(f, 'left over');
  repair(b);
  for (const f of leftovers) assert.equal(fs.existsSync(f), false);
  fs.rmSync(b.files.messagesDir, { recursive: true });
  fs.writeFileSync(b.files.messagesDir, 'a file where the messages folder belongs');
  assert.throws(() => repair(b));
  assert.deepEqual(transact(b, () => ({ events: [post(1, 'still writable')] })).degraded, ['messages', 'snapshot']);
  // The rebuild the fence triggers is just as lenient.
  let calls = 0;
  const out = transact(b, (s) => {
    if (calls++ === 0) fs.appendFileSync(b.files.events, JSON.stringify({ seq: s.seq + 1, at: T0, ...createEv(s.nextId, 'foreign') }) + '\n');
    return { events: [post(1, 'after the fence')] };
  });
  assert.equal(calls, 2);
  assert.deepEqual(out.degraded, ['messages', 'snapshot']);
  assert.equal(readState(b).tasks[1].messageCount, 3);
});

test('repair rewrites message files in place and removes files no task needs', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  transact(b, () => ({ events: [post(1, 'hi')] }));
  fs.writeFileSync(messagesFile(b, 1), 'garbage\n');
  fs.writeFileSync(messagesFile(b, 7), '{"text":"orphan"}\n');
  repair(b);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
  assert.deepEqual(fs.readdirSync(b.files.messagesDir), ['1.jsonl']);
});

test('a lock that cannot be released after a committed write is logged, and the write reported as done', () => {
  const b = openBoard(tempRepo());
  const lock = path.join(b.dir, 'lock');
  const out = transact(b, () => {
    fs.rmSync(lock);
    fs.mkdirSync(lock); // releasing will fail: the lock is a folder now
    return { events: [createEv(1)], result: 'ok' };
  });
  assert.equal(out.result, 'ok');
  assert.equal(out.events[0].seq, 1);
  assert.match(fs.readFileSync(b.files.errors, 'utf8'), /lock release/);
  fs.rmSync(lock, { recursive: true });
  transact(b, () => ({ events: [createEv(2)] }));
  assert.deepEqual(Object.keys(readState(b).tasks), ['1', '2']);
});

test('a misshapen registry reads as empty parts', () => {
  const b = openBoard(tempRepo());
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(b.files.agents, JSON.stringify({ agents: null, activity: { 1: T0 }, touches: [] }));
  assert.deepEqual(readRegistry(b), { agents: {}, activity: { 1: T0 }, touches: {} });
  fs.writeFileSync(b.files.agents, '[1, 2]');
  assert.deepEqual(readRegistry(b), { agents: {}, activity: {}, touches: {} });
});

test('malformed registry entries are dropped, so one bad entry cannot make every write throw', () => {
  const b = openBoard(tempRepo());
  fs.mkdirSync(b.dir, { recursive: true });
  const touch = { agent: 'a1', task: 1, at: T0 };
  fs.writeFileSync(b.files.agents, JSON.stringify({
    agents: { a1: { id: 'a1', name: 'Amber', color: '#A45F00' }, '': { id: '' }, a2: null, a3: 'x', a4: [1] },
    activity: { 1: T0, 2: 'soon', 3: null, 4: {} },
    touches: { 'src/a.js': touch, 'src/b.js': null, 'src/c.js': 5, 'src/d.js': ['a1'] },
    version: 3, // other top-level keys are kept
  }));
  const clean = { agents: { a1: { id: 'a1', name: 'Amber', color: '#A45F00' } }, activity: { 1: T0 }, touches: { 'src/a.js': touch }, version: 3 };
  assert.deepEqual(readRegistry(b), clean);
  // A write that walks every agent works, and saves the cleaned registry.
  const out = transact(b, (s, reg) => ({ result: Object.values(reg.agents).map((a) => a.id), registry: reg }));
  assert.deepEqual(out.result, ['a1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.files.agents, 'utf8')), clean);
  // A "__proto__" id stays an ordinary entry and never replaces the prototype.
  fs.writeFileSync(b.files.agents, '{"agents":{"__proto__":{"id":"p"}}}');
  const reg = readRegistry(b);
  assert.equal(Object.getPrototypeOf(reg.agents), Object.prototype);
  assert.ok(Object.hasOwn(reg.agents, '__proto__'));
});

test('agent cursors are board sequence numbers: an unusable cursor or prevCursor is dropped, the agent kept', () => {
  const b = openBoard(tempRepo());
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(b.files.agents, JSON.stringify({
    agents: {
      a1: { id: 'a1', name: 'Amber', color: '#A45F00', cursor: 12, prevCursor: 0 },
      a2: { id: 'a2', name: 'Jade', color: '#17735A', cursor: -1, prevCursor: 2.5 },
      a3: { id: 'a3', name: 'Cobalt', color: '#2F4DB5', cursor: '12', prevCursor: null },
      a4: { id: 'a4', name: 'Plum', color: '#7A3E8E', cursor: 1e300, prevCursor: { seq: 3 } },
      a5: { id: 'a5', name: 'Rust', color: '#A3401F' },
    },
  }));
  const clean = {
    a1: { id: 'a1', name: 'Amber', color: '#A45F00', cursor: 12, prevCursor: 0 },
    a2: { id: 'a2', name: 'Jade', color: '#17735A' },
    a3: { id: 'a3', name: 'Cobalt', color: '#2F4DB5' },
    a4: { id: 'a4', name: 'Plum', color: '#7A3E8E' },
    a5: { id: 'a5', name: 'Rust', color: '#A3401F' },
  };
  assert.deepEqual(readRegistry(b).agents, clean);
  transact(b, (s, reg) => ({ registry: reg }));
  assert.deepEqual(JSON.parse(fs.readFileSync(b.files.agents, 'utf8')).agents, clean);
  // an agent object holding a "__proto__" key stays an ordinary object
  fs.writeFileSync(b.files.agents, '{"agents":{"a1":{"id":"a1","cursor":-5,"__proto__":{"cursor":7}}}}');
  const a1 = readRegistry(b).agents.a1;
  assert.equal(Object.getPrototypeOf(a1), Object.prototype);
  assert.deepEqual([Object.hasOwn(a1, 'cursor'), a1.cursor], [false, undefined]);
});

test('the registry reader drops an unusable lastFile', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  fs.mkdirSync(board.dir, { recursive: true });
  fs.writeFileSync(board.files.agents, JSON.stringify({ agents: {
    a1: { id: 'a1', name: 'Amber', color: '#A45F00', lastFile: 42, lastFileAt: 'x' },
    a2: { id: 'a2', name: 'Jade', color: '#17735A', lastFile: 'src/app.js', lastFileAt: T0 },
    a3: { id: 'a3', name: 'Cobalt', color: '#2F4DB5', lastFile: '', lastFileAt: null },
    a4: { id: 'a4', name: 'Plum', color: '#7A3E8E', lastFile: 'x'.repeat(1001), lastFileAt: String(T0) },
  } }));
  const reg = readRegistry(board);
  for (const id of ['a1', 'a3', 'a4']) {
    assert.equal(Object.hasOwn(reg.agents[id], 'lastFile'), false);
    assert.equal(Object.hasOwn(reg.agents[id], 'lastFileAt'), false);
  }
  assert.equal(reg.agents.a2.lastFile, 'src/app.js');
  assert.equal(reg.agents.a2.lastFileAt, T0);
});

test('the registry reader gives every agent a usable, unique name and a #rrggbb color, the same on every read', () => {
  const b = openBoard(tempRepo());
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(b.files.agents, JSON.stringify({
    agents: {
      a1: { id: 'a1', name: 'Amber', color: '#A45F00' },
      a2: { id: 'a2', name: { first: 'Jade' }, color: '#17735A' },
      a3: { id: 'a3', name: '', color: 'red' },
      a4: { id: 'a4', name: '  Cobalt ', color: 42 },
      a5: { id: 'a5', name: 'J'.repeat(61) },
      a6: { id: 'a6', name: 'Rosemary', color: '#12345' },
      a7: { id: 'a7', name: 'Plum 2', color: '#abcdef' },
      a8: { id: 'a8' },
      a9: { id: 'a9', name: 'Jade 3', color: 'teal' },
    },
  }));
  const reg = readRegistry(b);
  const named = Object.values(reg.agents).map((a) => [a.id, a.name, a.color]);
  assert.deepEqual(named, [
    ['a1', 'Amber', '#A45F00'],
    ['a2', 'Jade', '#17735A'], // the first palette name no entry holds, with its color
    ['a3', 'Plum', '#7A3E8E'], // "Plum 2" is held, "Plum" is not
    ['a4', 'Cobalt', '#2F4DB5'], // a usable name is kept, trimmed; the color follows the palette name
    ['a5', 'Rust', '#A3401F'],
    ['a6', 'Rosemary', named[5][2]], // not a palette name: a palette color picked from the name
    ['a7', 'Plum 2', '#abcdef'], // any valid #rrggbb stays
    ['a8', 'Moss', '#4F6B1F'],
    ['a9', 'Jade 3', '#17735A'], // a numbered name gets its palette name's color
  ]);
  assert.ok(PALETTE.some(([, color]) => color === named[5][2]));
  assert.equal(new Set(named.map(([, name]) => name)).size, named.length);
  assert.deepEqual(readRegistry(b), reg); // determined by the file alone
  transact(b, (s, r) => ({ registry: r }));
  assert.deepEqual(readRegistry(b), reg); // and stable once saved
  // with every palette name held, repaired names are numbered
  const full = Object.fromEntries(PALETTE.map(([name, color], i) => [`p${i}`, { id: `p${i}`, name, color }]));
  fs.writeFileSync(b.files.agents, JSON.stringify({ agents: { ...full, x1: { id: 'x1', name: null }, x2: { id: 'x2', name: 5 } } }));
  const more = readRegistry(b).agents;
  assert.deepEqual([more.x1.name, more.x1.color, more.x2.name, more.x2.color], ['Amber 2', '#A45F00', 'Jade 2', '#17735A']);
});

test('after the reader repairs a name, ops write a proper name into system notes and events', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({
    events: [createEv(1), { type: 'task.claimed', actor: 'a2', data: { id: 1, agent: 'a2', agentName: 'Jade', folder: '/w/b' } }],
  }));
  fs.writeFileSync(b.files.agents, JSON.stringify({
    agents: {
      a1: { id: 'a1', name: { first: 'Amber' }, color: 7, folder: '/w/a', endedAt: null, lastSeen: T0, cursor: 2 },
      a2: { id: 'a2', name: 'Jade', color: '#17735A', folder: '/w/b', endedAt: T0, lastSeen: T0 },
    },
  }));
  const ctx = { state: readState(b), reg: readRegistry(b), cfg: DEFAULTS, agentId: 'a1', now: T0 + MIN };
  assert.equal(ctx.reg.agents.a1.name, 'Amber');
  const out = claimTask(ctx, { id: 1, takeOver: true });
  assert.equal(out.events[0].data.message.text, 'Amber took over from Jade, whose session had ended (folder /w/b).');
  assert.equal(out.events[1].data.agentName, 'Amber');
});

test('housekeeping (before) runs first: fn sees its effects, and both are written as one batch', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1), { type: 'task.claimed', actor: 'a1', data: { id: 1, agent: 'a1', folder: null } }] }));
  const before = (s, reg) => {
    reg.touches['src/old.js'] = { agent: 'a1', task: 1, at: T0 };
    return s.tasks[1].assignee ? [
      { type: 'task.released', actor: 'system', data: { id: 1, reason: 'timeout' } },
      post(1, 'Released after 24 h without activity', 'system'),
    ] : [];
  };
  let seen = null;
  const out = transact(b, (s, reg) => {
    seen = { assignee: s.tasks[1].assignee, seq: s.seq, touched: Object.hasOwn(reg.touches, 'src/old.js') };
    return { events: [{ type: 'task.claimed', actor: 'a2', data: { id: 1, agent: 'a2', folder: null } }], registry: reg };
  }, { before, now: T0 });
  assert.deepEqual(seen, { assignee: null, seq: 4, touched: true }); // the released claim is gone
  assert.deepEqual(out.events.map((e) => [e.seq, e.tx, e.n, e.type]),
    [[3, 3, 3, 'task.released'], [4, 3, 3, 'message.posted'], [5, 3, 3, 'task.claimed']]);
  assert.deepEqual(logLines(b).slice(2).map((l) => JSON.parse(l)).map((e) => [e.seq, e.tx, e.n]), [[3, 3, 3], [4, 3, 3], [5, 3, 3]]);
  assert.equal(out.state.tasks[1].assignee, 'a2');
  assert.deepEqual(readMessages(b, 1).map((m) => [m.id, m.text]), [['m4', 'Released after 24 h without activity']]);
  assert.equal(readRegistry(b).touches['src/old.js'].agent, 'a1');
  assert.deepStrictEqual(readState(b), replay(b, { messages: false }).state);
  assert.deepEqual(repair(b).bad, []);
});

test('if fn throws, the housekeeping events are not written either', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const log = fs.readFileSync(b.files.events, 'utf8');
  const fail = () => { throw new Error('operation refused (test)'); };
  assert.throws(() => transact(b, fail, { before: (s, reg) => { reg.agents.x = { id: 'x' }; return [createEv(2)]; } }), /operation refused/);
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), log);
  assert.deepEqual(Object.keys(readState(b).tasks), ['1']);
  assert.equal(fs.existsSync(b.files.agents), false);
});

test('on a fence re-run, housekeeping runs again on the rebuilt state', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const seenByBefore = [];
  let calls = 0;
  const out = transact(b, (s) => {
    if (calls++ === 0) fs.appendFileSync(b.files.events, JSON.stringify({ seq: 2, at: T0, ...createEv(2, 'foreign') }) + '\n');
    return { events: [createEv(s.nextId)] };
  }, {
    before: (s) => {
      seenByBefore.push(s.seq);
      return [post(1, `sweep after seq ${s.seq}`, 'system')];
    },
  });
  assert.deepEqual(seenByBefore, [1, 2]);
  assert.deepEqual(out.events.map((e) => [e.seq, e.tx, e.n, e.type]), [[3, 3, 2, 'message.posted'], [4, 3, 2, 'task.created']]);
  assert.equal(out.state.tasks[3].id, 3);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['sweep after seq 2']);
  assert.deepStrictEqual(readState(b), replay(b, { messages: false }).state);
});

test('the registry is saved only when returned', () => {
  const b = openBoard(tempRepo());
  assert.deepEqual(readRegistry(b), { agents: {}, activity: {}, touches: {} });
  transact(b, (s, reg) => {
    reg.agents.x = { id: 'x' };
    return { registry: reg };
  });
  assert.equal(readRegistry(b).agents.x.id, 'x');
});

test('property: after random writes, snapshot, tail catch-up and message files all match a replay', () => {
  const b = openBoard(tempRepo());
  const random = rng(20260930);
  const pick = (list) => list[Math.floor(random() * list.length)];
  let older = null;
  for (let round = 0; round < 80; round++) {
    transact(b, (s, reg) => {
      let nextId = s.nextId;
      const events = [];
      for (let k = 0, size = 1 + Math.floor(random() * 3); k < size; k++) {
        const id = 1 + Math.floor(random() * nextId); // sometimes a task that does not exist yet
        const r = random();
        if (r < 0.25) events.push(createEv(nextId++));
        else if (r < 0.6) {
          const kind = pick(['comment', 'question', 'answer', 'handoff', 'summary']);
          events.push(post(id, `text ${round}.${k}`, kind, { replyTo: `m${1 + Math.floor(random() * (s.seq + 1))}` }));
        } else if (r < 0.75) events.push({ type: 'task.claimed', actor: 'a1', data: { id, agent: pick(['a1', 'a2']), folder: null } });
        else if (r < 0.85) events.push({ type: 'task.completed', actor: 'a2', data: { id, summary: 'done' } });
        else if (r < 0.95) events.push({ type: 'task.released', actor: 'a1', data: { id } });
        else events.push({ type: 'task.checklist', actor: 'a1', data: { id, items: [{ text: 'a', done: random() < 0.5 }] } });
      }
      if (random() < 0.1) {
        reg.agents.a1 = { id: 'a1', round };
        return { events, registry: reg };
      }
      return { events };
    }, { now: T0 + round });
    if (round === 40) older = fs.readFileSync(b.files.state);
  }
  const full = replay(b);
  assert.deepEqual(full.bad, []);
  assert.ok(Object.values(full.state.tasks).some((task) => task.messageCount > 0));
  assert.deepStrictEqual(readState(b), full.state);
  for (let id = 1; id <= full.state.nextId; id++) assert.deepStrictEqual(readMessages(b, id), full.messages.get(id) ?? []);
  assert.ok(JSON.parse(older.toString()).seq < full.state.seq);
  fs.writeFileSync(b.files.state, older); // many writes behind: a reader catches up from the tail
  assert.deepStrictEqual(readState(b), replay(b, { messages: false }).state);
});

test('concurrent processes create unique ids without losing events', async () => {
  const repo = tempRepo();
  const storeUrl = new URL('../../src/core/store.js', import.meta.url).href;
  const worker = `
    import { openBoard, transact } from ${JSON.stringify(storeUrl)};
    const b = openBoard(process.argv[1]);
    for (let i = 0; i < 25; i++) transact(b, (s) => ({ events: [{ type: 'task.created', actor: 'w',
      data: { task: { id: s.nextId, kind: 'task', title: 't', origin: 'human', createdBy: 'human', approved: true, rank: s.nextId } } }] }));`;
  await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', worker, repo], { stdio: 'inherit' });
    c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  })));
  const s = readState(openBoard(repo));
  assert.equal(Object.keys(s.tasks).length, 100);
  assert.equal(s.seq, 100);
  assert.equal(s.nextId, 101);
});

test('housekeeping (before) registry changes are saved even when fn returns no registry', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }), {
    before: (s, reg) => { reg.sweptAt = T0; reg.touches['src/a.js'] = { agent: 'a1', task: 1, at: T0 }; },
  });
  const reg = readRegistry(b);
  assert.equal(reg.sweptAt, T0);
  assert.equal(reg.touches['src/a.js'].agent, 'a1');
  assert.equal(JSON.parse(fs.readFileSync(b.files.agents, 'utf8')).sweptAt, T0);
});
