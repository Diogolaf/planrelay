import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { writeJsonAtomic } from '../../src/core/fsx.js';
import { openBoard } from '../../src/core/store.js';
import { dashboardFile, ensureDashboard, openBrowser, runningDashboard, serveDashboard } from '../../src/dashboard/launch.js';
import { boardId } from '../../src/dashboard/server.js';
import { tempRepo } from '../helpers.js';

const CLI = path.resolve('src/cli.js');
const PORT = 51234;
const DASH_URL = `http://127.0.0.1:${PORT}/`;

/** A child process as spawn returns it, with a pid and unref(). */
function fakeChild(pid) {
  const child = Object.assign(new EventEmitter(), { pid, unrefed: false });
  return Object.assign(child, { unref: () => { child.unrefed = true; } });
}

/**
 * ensureDashboard's io on a fake clock: `spawn` records its call and runs `onSpawn` with the child
 * (pid 4242), `sleep` advances the clock, `open` records the URL, `alive` is true for 4242 only.
 */
function fakeIo(onSpawn = (_child) => {}) {
  let t = 1_000_000;
  /** @type {any} */
  const io = {
    spawned: [],
    opened: [],
    slept: [],
    children: [],
    spawn: (command, args, options) => {
      io.spawned.push({ command, args, options });
      const child = fakeChild(4242);
      io.children.push(child);
      onSpawn(child);
      return child;
    },
    open: (url) => io.opened.push(url),
    sleep: (ms) => {
      io.slept.push(ms);
      t += ms;
    },
    now: () => t,
    alive: (pid) => pid === 4242,
  };
  return io;
}

const record = (board, rec) => writeJsonAtomic(dashboardFile(board), rec);

test('ensureDashboard starts a detached dashboard, waits for its dashboard.json and opens its URL; a second call reuses it', () => {
  const board = openBoard(tempRepo());
  const io = fakeIo((child) => record(board, { pid: child.pid, port: PORT, startedAt: 1, board: boardId(board) }));
  assert.deepEqual(ensureDashboard(board, io), { url: DASH_URL, reused: false });
  assert.equal(io.spawned.length, 1);
  assert.deepEqual(io.spawned[0], {
    command: process.execPath,
    args: [CLI, 'dashboard', '--dir', board.repoRoot, '--no-open'],
    options: { detached: true, stdio: 'ignore', windowsHide: true },
  });
  assert.equal(io.children[0].unrefed, true);
  assert.ok(io.children[0].listenerCount('error') > 0); // a failed start never crashes the MCP server
  assert.deepEqual(io.opened, [DASH_URL]);

  assert.deepEqual(ensureDashboard(board, io), { url: DASH_URL, reused: true });
  assert.equal(io.spawned.length, 1);
  assert.deepEqual(io.opened, [DASH_URL, DASH_URL]);
});

test('ensureDashboard polls every 100 ms until the new dashboard records itself', () => {
  const board = openBoard(tempRepo());
  const io = fakeIo();
  const sleep = io.sleep;
  io.sleep = (ms) => {
    sleep(ms);
    if (io.slept.length === 3) record(board, { pid: 4242, port: PORT, startedAt: 1, board: boardId(board) });
  };
  assert.deepEqual(ensureDashboard(board, io), { url: DASH_URL, reused: false });
  assert.deepEqual(io.slept, [100, 100, 100]);
});

test('a stale dashboard.json (its process is gone) starts a new dashboard', () => {
  const board = openBoard(tempRepo());
  record(board, { pid: 999, port: 40000, startedAt: 1, board: boardId(board) });
  const io = fakeIo((child) => record(board, { pid: child.pid, port: PORT, startedAt: 2, board: boardId(board) }));
  assert.deepEqual(ensureDashboard(board, io), { url: DASH_URL, reused: false });
  assert.equal(io.spawned.length, 1);
  assert.deepEqual(io.opened, [DASH_URL]);
});

test('the URL is always built from a valid port, never taken from dashboard.json', () => {
  const board = openBoard(tempRepo());
  for (const port of ['8080', 8080.5, 0, 70000, '1234@evil.example', null]) {
    record(board, { pid: 4242, port, url: 'http://evil.example/', board: boardId(board) });
    assert.equal(runningDashboard(board, () => true), null, String(port));
  }
  record(board, { pid: 4242, port: PORT, url: 'http://evil.example/' });
  assert.deepEqual(runningDashboard(board, () => true), { pid: 4242, url: DASH_URL });
  assert.equal(runningDashboard(board, () => false), null);
  fs.writeFileSync(dashboardFile(board), 'not json');
  assert.equal(runningDashboard(board, () => true), null);
});

test('a dashboard that never records itself: a BoardError after 5 s that says what to do', () => {
  const board = openBoard(tempRepo());
  const io = fakeIo();
  assert.throws(() => ensureDashboard(board, io), (err) => {
    assert.equal(/** @type {any} */ (err).name, 'BoardError');
    assert.match(/** @type {any} */ (err).message, /^The dashboard did not start within 5 seconds\. .*`agentboard dashboard`.* in a terminal/);
    return true;
  });
  assert.equal(io.slept.reduce((a, b) => a + b, 0), 5000);
  assert.deepEqual(io.opened, []);
});

test('openBrowser runs the platform opener, detached, and never throws', () => {
  /** @type {any[]} */
  const calls = [];
  const children = [];
  const spawn = (command, args, options) => {
    calls.push([command, args, options]);
    const child = fakeChild(1);
    children.push(child);
    return child;
  };
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  openBrowser(DASH_URL, { spawn, platform: 'win32' });
  openBrowser(DASH_URL, { spawn, platform: 'darwin' });
  openBrowser(DASH_URL, { spawn, platform: 'linux' });
  assert.deepEqual(calls, [
    ['rundll32', ['url.dll,FileProtocolHandler', DASH_URL], options],
    ['open', [DASH_URL], options],
    ['xdg-open', [DASH_URL], options],
  ]);
  for (const child of children) {
    assert.equal(child.unrefed, true);
    child.emit('error', new Error('spawn xdg-open ENOENT')); // no opener installed: handled
  }
  openBrowser(DASH_URL, { spawn: () => { throw new Error('spawn failed on purpose'); }, platform: 'linux' });
});

/** A stand-in for `process`: its pid (this live process), its signals, and exit() recorded. */
function fakeProc() {
  return Object.assign(new EventEmitter(), { pid: process.pid, exits: /** @type {number[]} */ ([]), exit(code) { this.exits.push(code); } });
}

/** GET /api/ping of a started dashboard. @param {string} url */
function ping(url) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
  });
}

/** Resolves once cond() is true, checking every 10 ms; rejects after `ms`. */
function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const check = () => (cond() ? resolve(undefined) : Date.now() > end ? reject(new Error('timed out')) : setTimeout(check, 10));
    check();
  });
}

test('serveDashboard records the dashboard it starts, is reused while it runs, and SIGINT closes it and removes the record', async () => {
  const board = openBoard(tempRepo());
  const proc = fakeProc();
  const started = await serveDashboard(board, { proc, now: () => 1234 });
  assert.equal(started.reused, false);
  const port = Number(new URL(started.url).port);
  assert.equal(started.url, `http://127.0.0.1:${port}/`);
  assert.deepEqual(JSON.parse(fs.readFileSync(dashboardFile(board), 'utf8')), { pid: process.pid, port, startedAt: 1234, board: boardId(board) });
  assert.deepEqual(await ping(started.url), { app: 'agentboard', board: boardId(board) });

  assert.deepEqual(await serveDashboard(board, { proc: fakeProc() }), { url: started.url, reused: true });

  proc.emit('SIGINT');
  await waitFor(() => proc.exits.length > 0);
  assert.deepEqual(proc.exits, [0]);
  assert.equal(fs.existsSync(dashboardFile(board)), false);
  await assert.rejects(ping(started.url));
});

test('on exit, dashboard.json is removed only while it still names this process', async () => {
  const board = openBoard(tempRepo());
  const proc = fakeProc();
  const started = await serveDashboard(board, { proc });
  proc.emit('exit', 0);
  assert.equal(fs.existsSync(dashboardFile(board)), false);
  const other = { pid: 4242, port: PORT, startedAt: 2, board: boardId(board) };
  record(board, other); // a newer dashboard of the same board
  proc.emit('SIGTERM');
  await waitFor(() => proc.exits.length > 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(dashboardFile(board), 'utf8')), other);
  await assert.rejects(ping(started.url));
});
