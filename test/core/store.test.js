import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBoard, transact, readState, readMessages, readRegistry, repair } from '../../src/core/store.js';
import { samePath } from '../../src/core/paths.js';
import { tempRepo, T0 } from '../helpers.js';

const createEv = (id, title = `Task ${id}`) => ({
  type: 'task.created', actor: 'a1',
  data: { task: { id, kind: 'task', title, origin: 'human', createdBy: 'human', approved: true, rank: id } },
});

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
  assert.equal(readState(b).tasks[1].title, 'Task 1');
  assert.equal(fs.readFileSync(b.files.events, 'utf8').trim().split('\n').length, 1);
});

test('messages get ids and land in their task file', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const out = transact(b, () => ({
    events: [{ type: 'message.posted', actor: 'a1', data: { message: { taskId: 1, author: 'a1', kind: 'comment', text: 'hi', mentions: [] } } }],
  }), { now: T0 });
  assert.equal(out.events[0].data.message.id, 'm2');
  assert.equal(out.events[0].data.message.at, T0);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
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

test('reported line numbers are the lines of the file, blank lines included', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.appendFileSync(b.files.events, '\n{broken\n');
  assert.deepEqual(repair(b).bad, [3]);
});

test('an event without a string type, or an async fn, is refused before anything is written', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  const before = fs.readFileSync(b.files.events, 'utf8');
  assert.throws(() => transact(b, () => ({ events: [createEv(2), { actor: 'a1', data: {} }] })), TypeError);
  assert.throws(() => transact(b, async () => ({ events: [createEv(2)] })), /must be synchronous/);
  assert.equal(fs.readFileSync(b.files.events, 'utf8'), before);
  assert.equal(readState(b).seq, 1);
});

test('a failed write after the commit is logged, reported as committed and rebuilt later', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  fs.mkdirSync(path.join(b.files.messagesDir, '1.jsonl'), { recursive: true }); // the message append will fail
  const post = { type: 'message.posted', actor: 'a1', data: { message: { taskId: 1, author: 'a1', kind: 'comment', text: 'hi', mentions: [] } } };
  const out = transact(b, (s, reg) => ({ events: [post], registry: reg, result: 'done' }));
  assert.equal(out.result, 'done');
  assert.equal(out.events[0].seq, 2);
  assert.match(fs.readFileSync(b.files.errors, 'utf8'), /snapshots after commit/);
  assert.equal(readState(b).tasks[1].messageCount, 1); // the snapshot is stale, so this is a replay
  fs.rmSync(path.join(b.files.messagesDir, '1.jsonl'), { recursive: true });
  transact(b, () => ({}));
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
  assert.equal(readState(b).seq, 2);
});

test('repair rewrites message files in place and removes files no task needs', () => {
  const b = openBoard(tempRepo());
  transact(b, () => ({ events: [createEv(1)] }));
  transact(b, () => ({
    events: [{ type: 'message.posted', actor: 'a1', data: { message: { taskId: 1, author: 'a1', kind: 'comment', text: 'hi', mentions: [] } } }],
  }));
  fs.writeFileSync(path.join(b.files.messagesDir, '1.jsonl'), 'garbage\n');
  fs.writeFileSync(path.join(b.files.messagesDir, '7.jsonl'), '{"text":"orphan"}\n');
  fs.writeFileSync(path.join(b.files.messagesDir, '1.jsonl.123.abc.tmp'), 'left over');
  repair(b);
  assert.deepEqual(readMessages(b, 1).map((m) => m.text), ['hi']);
  assert.deepEqual(fs.readdirSync(b.files.messagesDir), ['1.jsonl']);
});

test('a misshapen registry reads as empty parts', () => {
  const b = openBoard(tempRepo());
  fs.mkdirSync(b.dir, { recursive: true });
  fs.writeFileSync(b.files.agents, JSON.stringify({ agents: null, activity: { 1: T0 }, touches: [] }));
  assert.deepEqual(readRegistry(b), { agents: {}, activity: { 1: T0 }, touches: {} });
  fs.writeFileSync(b.files.agents, '[1, 2]');
  assert.deepEqual(readRegistry(b), { agents: {}, activity: {}, touches: {} });
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

test('concurrent processes create unique ids without losing events', async () => {
  const repo = tempRepo();
  const storeUrl = pathToFileURL(path.resolve('src/core/store.js')).href;
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
