import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openBoard } from '../../src/core/store.js';
import { watchBoard } from '../../src/dashboard/watch.js';
import { buildTools } from '../../src/mcp/tools.js';
import { tempRepo } from '../helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once cond() is true, checking every 10 ms; rejects after `ms`. */
function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const check = () => (cond() ? resolve(undefined) : Date.now() > end ? reject(new Error('timed out')) : setTimeout(check, 10));
    check();
  });
}

/** A fresh board with no folder yet, and write(): one create_task of an agent, a real write through transact. */
function boardWithWriter() {
  const repo = tempRepo();
  const board = openBoard(repo);
  const create = /** @type {any} */ (buildTools(board, { sessionId: 's1', folder: repo }).find((t) => t.name === 'create_task')).handler;
  let n = 0;
  const write = () => {
    n += 1;
    create({ title: `Recipe card ${n}`, requestedByHuman: true });
  };
  return { board, write };
}

test('a burst of five writes is one change, within a second', async () => {
  const { board, write } = boardWithWriter();
  write(); // the board folder exists now
  /** @type {number[]} */
  const calls = [];
  const w = watchBoard(board, () => calls.push(Date.now()), { pollMs: 60_000 });
  try {
    assert.equal(w.watching, true);
    for (let i = 0; i < 5; i += 1) write();
    const done = Date.now();
    await waitFor(() => calls.length > 0, 1000);
    assert.ok(calls[0] - done < 1000);
    await sleep(400);
    assert.equal(calls.length, 1);
  } finally {
    w.close();
  }
});

test('polling alone sees a change when fs.watch is off', async () => {
  const { board, write } = boardWithWriter();
  write();
  let calls = 0;
  const w = watchBoard(board, () => { calls += 1; }, { pollMs: 50, fsWatch: false });
  try {
    assert.equal(w.watching, false);
    await sleep(200);
    assert.equal(calls, 0); // nothing changed
    write();
    await waitFor(() => calls === 1);
    await sleep(300);
    assert.equal(calls, 1);
    assert.equal(w.watching, false);
  } finally {
    w.close();
  }
});

test('a board folder created after the start is picked up, then watched', async () => {
  const { board, write } = boardWithWriter();
  assert.equal(fs.existsSync(board.dir), false);
  let calls = 0;
  const w = watchBoard(board, () => { calls += 1; }, { pollMs: 50 });
  try {
    assert.equal(w.watching, false);
    await sleep(120);
    assert.equal(calls, 0);
    write();
    await waitFor(() => calls === 1);
    await waitFor(() => w.watching);
  } finally {
    w.close();
  }
});

test('a deleted board folder drops the watcher without spinning; once it is back, it is watched again', async (t) => {
  const { board, write } = boardWithWriter();
  write();
  // count what fs.watch delivers, to see a later write arrive through the new watcher
  const realWatch = fs.watch;
  let delivered = 0;
  t.mock.method(fs, 'watch', (dir, listener) => realWatch(dir, (type, name) => {
    delivered += 1;
    listener(type, name);
  }));
  let calls = 0;
  const w = watchBoard(board, () => { calls += 1; }, { pollMs: 100, debounceMs: 20 });
  try {
    assert.equal(w.watching, true);
    fs.rmSync(board.dir, { recursive: true, force: true });
    await waitFor(() => !w.watching);
    // Windows reports a deleted watched folder by its own path, over and over, until it is closed
    const cpu = process.cpuUsage();
    const start = Date.now();
    await sleep(500);
    const diff = process.cpuUsage(cpu);
    const used = (diff.user + diff.system) / 1000;
    assert.ok(used < 0.5 * (Date.now() - start), `${Math.round(used)} ms of CPU in ${Date.now() - start} ms`);
    write(); // the folder is back
    await waitFor(() => w.watching);
    const seen = calls;
    const before = delivered;
    write();
    await waitFor(() => calls > seen);
    assert.ok(delivered > before);
  } finally {
    w.close();
  }
});

test('a failing onChange is logged, and watching goes on', async () => {
  const { board, write } = boardWithWriter();
  write();
  let calls = 0;
  const w = watchBoard(board, () => {
    calls += 1;
    throw new Error('listener failed on purpose');
  }, { pollMs: 50 });
  try {
    write();
    await waitFor(() => calls === 1);
    write();
    await waitFor(() => calls === 2);
    assert.match(fs.readFileSync(board.files.errors, 'utf8'), /dashboard watch: Error: listener failed on purpose/);
  } finally {
    w.close();
  }
});

test('close() stops the watcher, the poll and a pending call; later writes call nothing', async () => {
  const { board, write } = boardWithWriter();
  write();
  let calls = 0;
  const w = watchBoard(board, () => { calls += 1; }, { pollMs: 20, debounceMs: 50 });
  assert.equal(w.watching, true);
  write();
  await sleep(30); // the poll has seen the write; its call is still pending
  w.close();
  w.close(); // a second close is harmless
  assert.equal(w.watching, false);
  write();
  await sleep(300);
  assert.equal(calls, 0);
  // nothing of the watcher is left running: this test file exits on its own
});
