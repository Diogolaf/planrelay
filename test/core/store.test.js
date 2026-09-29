import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  openBoard, transact, readState, readMessages, readRegistry, repair, replay, messagesFile,
} from '../../src/core/store.js';
import { samePath } from '../../src/core/paths.js';
import { tempRepo, T0 } from '../helpers.js';

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
  fs.writeFileSync(b.files.state, JSON.stringify({ schema: 1, seq: 1, nextId: 2, eventsSize: size, tasks: null, recent: [], messages: [] }));
  assert.equal(readState(b).tasks[1].title, 'Task 1');
  fs.rmSync(b.files.state);
  fs.mkdirSync(b.files.state); // a folder where the snapshot should be
  assert.equal(readState(b).tasks[1].title, 'Task 1');
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
  assert.equal(readRegistry(b).agents.z.id, 'z'); // written first; harmless without the events
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), before);
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
    agents: { a1: { id: 'a1' }, '': { id: '' }, a2: null, a3: 'x', a4: [1] },
    activity: { 1: T0, 2: 'soon', 3: null, 4: {} },
    touches: { 'src/a.js': touch, 'src/b.js': null, 'src/c.js': 5, 'src/d.js': ['a1'] },
    version: 3, // other top-level keys are kept
  }));
  const clean = { agents: { a1: { id: 'a1' } }, activity: { 1: T0 }, touches: { 'src/a.js': touch }, version: 3 };
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
