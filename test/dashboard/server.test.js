import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { buildView } from '../../src/dashboard/view.js';
import { createDashboardServer, startDashboard, boardId } from '../../src/dashboard/server.js';
import { NAME } from '../../src/name.js';
import { buildRecipesBoard, FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { tempRepo } from '../helpers.js';

const NOW = Date.UTC(2026, 8, 30, 15, 0);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** @type {string} */
let repo;
/** @type {any} */
let board;
/** @type {Awaited<ReturnType<typeof startDashboard>>} */
let dash;

before(async () => {
  repo = tempRepo();
  board = buildRecipesBoard(repo, { now: NOW });
  dash = await startDashboard({ board, port: 0, now: () => NOW });
});
after(() => dash.close());

/**
 * One request on a fresh connection (no keep-alive pool left open), with the Host header of the
 * started server unless `host` is given.
 * @param {number} port @param {string} reqPath
 * @param {{ method?: string, host?: string }} [opts]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(port, reqPath, { method = 'GET', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers: { host }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const get = (reqPath, opts) => request(dash.port, reqPath, opts);
const json = async (reqPath) => {
  const res = await get(reqPath);
  return { ...res, data: JSON.parse(res.body) };
};

test('startDashboard listens on 127.0.0.1 and gives its URL', () => {
  const addr = /** @type {import('node:net').AddressInfo} */ (dash.server.address());
  assert.equal(addr.address, '127.0.0.1');
  assert.equal(addr.port, dash.port);
  assert.equal(dash.url, `http://127.0.0.1:${dash.port}/`);
});

test('GET / serves the app shell with the security headers', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] ?? '', /^text\/html; charset=utf-8$/);
  assert.match(res.body, /<!doctype html>/i);
  assert.equal(res.headers['content-security-policy'], CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('a foreign Host header gets 403, localhost is fine', async () => {
  for (const host of [`evil.example:${dash.port}`, '127.0.0.1:1', '127.0.0.1', `127.0.0.1:${dash.port}.evil.example`]) {
    const res = await get('/api/view', { host });
    assert.equal(res.status, 403, host);
    assert.equal(res.body, 'Forbidden host');
    assert.equal(res.headers['content-security-policy'], CSP); // every response
  }
  assert.equal((await get('/api/ping', { host: `localhost:${dash.port}` })).status, 200);
});

test('only GET and HEAD are answered', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await get('/api/view', { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.allow, 'GET, HEAD');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  const head = await get('/api/view', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.match(head.headers['content-type'] ?? '', /^application\/json/);
});

test('/api/view is the view model of the board', async () => {
  const res = await json('/api/view');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers['content-type'] ?? '', /^application\/json; charset=utf-8$/);
  assert.equal(res.data.project, path.basename(repo));
  assert.equal(res.data.now, NOW);
  assert.equal(res.data.badLines, 0);
  assert.deepEqual(res.data.counts, { backlog: 2, ready: 3, in_progress: 2, blocked: 2, done: 2, suggested: 2 });
  assert.equal(res.data.activeCount, 2);
});

test('/api/view passes local midnight, the host and the process check to buildView', async () => {
  /** @type {any} */
  let seen;
  const alive = () => true;
  const s = await startDashboard({ board, now: () => NOW, host: 'test-host', alive, build: (input) => { seen = input; return {}; } });
  try {
    assert.equal((await request(s.port, '/api/view')).status, 200);
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    assert.equal(seen.midnight, d.getTime());
    assert.equal(seen.host, 'test-host');
    assert.equal(seen.alive, alive);
    assert.equal(seen.projectName, board.projectName);
    assert.ok(seen.cfg && Number.isFinite(seen.cfg.claimTimeoutHours));
  } finally {
    await s.close();
  }
});

test('badLines comes from the log, checked at most every 30 s', async () => {
  const r = tempRepo();
  const b = buildRecipesBoard(r, { now: NOW });
  let now = NOW;
  const s = await startDashboard({ board: b, now: () => now });
  try {
    const bad = async () => JSON.parse((await request(s.port, '/api/view')).body).badLines;
    assert.equal(await bad(), 0);
    fs.appendFileSync(b.files.events, 'not json\n');
    now += 29_000;
    assert.equal(await bad(), 0); // cached
    now += 1_000;
    assert.equal(await bad(), 1);
  } finally {
    await s.close();
  }
});

test('/api/task/<n>: the task view, 404 for a missing task, 400 for a malformed id', async () => {
  const ok = await json(`/api/task/${ID.vegetarian}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.data.title, 'Vegetarian filter');
  assert.ok(ok.data.conversation.some((e) => e.tag === 'COMMENT')); // messages were read
  const missing = await json('/api/task/999');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.data.error, 'string');
  for (const id of ['abc', '0', '-1', '5.5', '05', '1e3', '99999999999999999999', '%35']) {
    const bad = await json(`/api/task/${id}`);
    assert.equal(bad.status, 400, id);
    assert.equal(typeof bad.data.error, 'string');
  }
});

test('/api/search finds tasks as list_tasks does', async () => {
  assert.deepEqual((await json('/api/search?q=vegetarian')).data, { ids: [ID.vegetarian], total: 1 });
  assert.deepEqual((await json(`/api/search?q=%23${ID.darkMode}`)).data, { ids: [ID.darkMode], total: 1 });
  assert.deepEqual((await json('/api/search?q=')).data, { ids: [], total: 0 });
  assert.deepEqual((await json('/api/search?q=+')).data, { ids: [], total: 0 });
  assert.deepEqual((await json('/api/search')).data, { ids: [], total: 0 });
});

test('/api/ping names the app and the board without a path', async () => {
  const res = await json('/api/ping');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.data).sort(), ['app', 'board']);
  assert.equal(res.data.app, NAME);
  assert.match(res.data.board, /^[0-9a-f]{16}$/);
  assert.equal(res.data.board, boardId(board));
  assert.ok(!res.body.includes(path.basename(repo)));
  assert.ok(!/[/\\]/.test(res.body));
});

test('static files stay inside the UI folder', async () => {
  const js = await get('/ui/format.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['cache-control'], 'no-cache');
  assert.match(js.body, /export function duration/);
  for (const p of [
    '/ui/../package.json', '/ui/%2e%2e/package.json', '/ui/..%5cpackage.json', '/ui/app.css.map', '/ui/', '/ui',
    '/ui/%2e%2e%2fpackage.json', '/ui/..%2f..%2fpackage.json', '/ui/%00format.js', '/ui/C:/Windows/notes.txt',
    '/ui/%2fetc%2fhosts.txt', '/ui/format.js:x', '/ui/missing.js', '/ui/%E0%A4%A.js', '/package.json', '/index.html',
  ]) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    assert.ok(!res.body.includes('"name"'), p);
  }
});

test('any other path gets 404', async () => {
  for (const p of ['/api', '/api/', '/api/nope', '/api/view/extra', '/favicon.ico', '/api/task/']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

/** Resolves once cond() is true, checking every 10 ms; rejects after `ms`. */
function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const check = () => (cond() ? resolve(undefined) : Date.now() > end ? reject(new Error('timed out')) : setTimeout(check, 10));
    check();
  });
}

/**
 * Opens /api/events and collects the stream. `until(text)` waits for text in what arrived so far.
 * @param {number} port
 */
function openEvents(port) {
  let text = '';
  /** @type {(() => void)[]} */
  let waiters = [];
  /** @type {http.IncomingMessage | undefined} */
  let response;
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
    response = res;
    res.setEncoding('utf8');
    res.on('data', (c) => {
      text += c;
      for (const w of waiters) w();
    });
  });
  req.on('error', () => {});
  req.end();
  return {
    get response() { return response; },
    /** @param {string} needle @param {number} [ms] */
    until: (needle, ms = 2000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${JSON.stringify(needle)} in ${JSON.stringify(text)}`)), ms);
      const check = () => {
        if (text.includes(needle)) {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== check);
          resolve(text);
        }
      };
      waiters.push(check);
      check();
    }),
    close: () => req.destroy(),
  };
}

test('/api/events sends a change for every notify, and heartbeats', async () => {
  const s = await startDashboard({ board, now: () => NOW, heartbeatMs: 50 });
  try {
    const events = openEvents(s.port);
    await events.until('retry: 2000\n\n');
    assert.equal(events.response?.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(events.response?.headers['content-security-policy'], CSP);
    s.notify(42);
    await events.until('event: change\ndata: 42\n\n');
    await events.until('\n\n: heartbeat\n\n');
    assert.equal(s.server.eventClients, 1);
    events.close();
    await waitFor(() => s.server.eventClients === 0); // dropped when its connection closes
    s.notify(43);
  } finally {
    await s.close();
  }
});

test('close() ends open event streams and the server', async () => {
  const s = await startDashboard({ board, now: () => NOW });
  const events = openEvents(s.port);
  await events.until('retry: 2000');
  const ended = new Promise((resolve) => events.response?.on('close', resolve));
  await s.close();
  await ended;
  assert.equal(s.server.listening, false);
});

test('a failing handler answers 500, logs the error and the server keeps going', async () => {
  let calls = 0;
  const errors = [];
  const s = await startDashboard({
    board,
    now: () => NOW,
    build: (input) => {
      calls += 1;
      if (calls === 1) throw new Error('view failed on purpose');
      return buildView(input);
    },
    onError: (err) => errors.push(err),
  });
  try {
    const res = await request(s.port, '/api/view');
    assert.equal(res.status, 500);
    assert.equal(typeof JSON.parse(res.body).error, 'string');
    assert.ok(!res.body.includes('failed on purpose'));
    assert.equal(res.headers['content-security-policy'], CSP);
    const log = fs.readFileSync(board.files.errors, 'utf8');
    assert.match(log, /dashboard .*view failed on purpose/);
    assert.equal(errors.length, 1);
    assert.equal((await request(s.port, '/api/view')).status, 200);
    assert.equal((await request(s.port, '/api/ping')).status, 200);
  } finally {
    await s.close();
  }
});

test('createDashboardServer returns a server that is not listening yet', async () => {
  const server = createDashboardServer({ board });
  assert.ok(server instanceof http.Server);
  assert.equal(server.listening, false);
  assert.equal(typeof server.notify, 'function');
});

test('a started server answers until closed, then its port is free', async () => {
  const s = await startDashboard({ board, now: () => NOW });
  assert.equal((await request(s.port, '/api/ping')).status, 200);
  await s.close();
  await assert.rejects(request(s.port, '/api/ping'));
});

