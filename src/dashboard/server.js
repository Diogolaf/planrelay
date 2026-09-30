import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NAME } from '../name.js';
import { currentHost } from '../core/agents.js';
import { loadConfig } from '../core/config.js';
import { pidAlive } from '../core/mutex.js';
import { BoardError } from '../core/ops.js';
import { listTasks } from '../core/queries.js';
import { logError, logHealth, readMessages, readRegistry, readState } from '../core/store.js';
import { buildTaskView } from './taskview.js';
import { buildView } from './view.js';
import { watchBoard } from './watch.js';

/**
 * The dashboard's local HTTP server (§13 Server, §14): the static UI and a read-only JSON API over
 * the board, plus server-sent events for live updates.
 * - Listens on 127.0.0.1 only and answers only requests whose Host header is 127.0.0.1:<port> or
 *   localhost:<port> (DNS rebinding); GET and HEAD only; no CORS headers.
 * - Every response carries the security headers (SECURITY), errors included.
 * - A failing handler is logged to errors.log and answered with 500; the server never crashes.
 * - Makes no outgoing request.
 *
 * @typedef {import('../core/store.js').Board} Board
 * @typedef {{
 *   board: Board,
 *   now?: () => number,
 *   host?: string | null,
 *   alive?: (pid: number) => boolean,
 *   uiDir?: string,
 *   onError?: (err: unknown) => void,
 *   build?: typeof buildView,
 *   heartbeatMs?: number,
 * }} DashboardOptions
 *   now: the clock (default Date.now); host, alive: for withDeadEnded (default currentHost(), pidAlive);
 *   uiDir: the static files (default src/dashboard/ui); onError: called after a handler failure is
 *   logged; build: replaces buildView (tests); heartbeatMs: the event stream's comment heartbeat.
 * @typedef {http.Server & { notify: (seq: number) => void, endEvents: () => void, readonly eventClients: number }} DashboardServer
 *   notify: sends `event: change` with the board's seq to every event stream (the watcher calls it);
 *   endEvents: ends every event stream; eventClients: how many are open.
 */

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Headers of every response. */
const SECURITY = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CSP,
});

/** The static files that may be served, by extension. */
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
});

const JSON_TYPE = 'application/json; charset=utf-8';
const UI_DIR = path.join(import.meta.dirname, 'ui');
/** logHealth reads the whole log, so its answer is kept this long. */
const BAD_LINES_MS = 30_000;
const HEARTBEAT_MS = 25_000;
const RETRY_MS = 2_000;
const SEARCH_LIMIT = 200;

/** The board's id for /api/ping and dashboard.json: the first 16 hex digits of the sha256 of its folder, so no path is shown. */
export function boardId(board) {
  return crypto.createHash('sha256').update(board.dir).digest('hex').slice(0, 16);
}

/** Local midnight (this machine's time zone) of the day of `now`. @param {number} now */
export function localMidnight(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The file under `uiDir` that the rest of a /ui/ path names, or null. The path is decoded once and
 * refused when it holds `..`, a backslash, NUL or a colon (a drive letter, or an NTFS stream), is
 * absolute, has an extension not in TYPES, or resolves outside `uiDir`.
 * @param {string} uiDir @param {string} rel @returns {string | null}
 */
export function uiFile(uiDir, rel) {
  let p;
  try {
    p = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (p === '' || p.includes('..') || /[\\\0:]/.test(p) || p.startsWith('/') || path.isAbsolute(p)) return null;
  if (!Object.hasOwn(TYPES, path.extname(p))) return null;
  const root = path.resolve(uiDir);
  const file = path.resolve(root, p);
  return file.startsWith(root + path.sep) ? file : null;
}

/** @param {http.ServerResponse} res @param {number} status @param {Record<string, string>} headers @param {string | Buffer} body */
function send(res, status, headers, body) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { ...SECURITY, ...headers, 'Content-Length': String(buf.length) });
  res.end(buf);
}
const sendText = (res, status, text, extra = {}) => send(res, status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra }, text);
const sendJson = (res, status, value) => send(res, status, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' }, JSON.stringify(value));
const notFound = (res) => sendText(res, 404, 'Not found');

/** Serves a static file, or 404 when it is not there. @param {http.ServerResponse} res @param {string} file */
async function serveFile(res, file) {
  let body;
  try {
    body = await fs.promises.readFile(file);
  } catch (err) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(/** @type {any} */ (err)?.code)) return notFound(res);
    throw err;
  }
  send(res, 200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' }, body);
}

/** Writes to an event stream unless it has ended. @param {http.ServerResponse} res @param {string} chunk */
function push(res, chunk) {
  if (!res.writableEnded && !res.destroyed) res.write(chunk);
}

/**
 * The dashboard server, not listening yet (startDashboard listens). Routes:
 * - `/`: ui/index.html; `/ui/<path>`: a static file (uiFile), `Cache-Control: no-cache`;
 * - `/api/view`: buildView over the current state, registry and config (reloaded on every request);
 * - `/api/task/<n>`: buildTaskView with the task's messages; 404 when no task has that number,
 *   400 when <n> is not a whole number of 1 or more;
 * - `/api/search?q=`: `{ ids, total }` of list_tasks' text filter (at most 200 ids), empty for an empty q;
 * - `/api/ping`: `{ app, board }` (boardId), never a path;
 * - `/api/events`: server-sent events (`retry`, then `event: change` per notify, a comment heartbeat);
 * - anything else: 404. The API answers with `Cache-Control: no-store`.
 * @param {DashboardOptions} opts
 * @returns {DashboardServer}
 */
export function createDashboardServer({
  board, now = Date.now, host = currentHost(), alive = pidAlive, uiDir = UI_DIR, onError, build = buildView, heartbeatMs = HEARTBEAT_MS,
}) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  const id = boardId(board);
  let health = { at: -Infinity, badLines: 0 };

  /** logHealth's count, read again once BAD_LINES_MS have passed (or the clock went back). @param {number} t */
  const badLines = (t) => {
    if (!(health.at <= t && t < health.at + BAD_LINES_MS)) health = { at: t, badLines: logHealth(board).badLines };
    return health.badLines;
  };

  const view = () => {
    const t = now();
    return build({
      state: readState(board), reg: readRegistry(board), cfg: loadConfig(board.configRoot), now: t, midnight: localMidnight(t),
      projectName: board.projectName, badLines: badLines(t), host, alive,
    });
  };

  /** @param {http.ServerResponse} res @param {string} raw */
  const task = (res, raw) => {
    const n = /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n)) return sendJson(res, 400, { error: 'A task id is a whole number of 1 or more, such as /api/task/12.' });
    const tv = buildTaskView({
      state: readState(board), reg: readRegistry(board), cfg: loadConfig(board.configRoot), now: now(), id: n, messages: readMessages(board, n), host, alive,
    });
    return tv ? sendJson(res, 200, tv) : sendJson(res, 404, { error: `No task #${n} on this board.` });
  };

  /** @param {http.ServerResponse} res @param {string} q */
  const search = (res, q) => {
    if (q.trim() === '') return sendJson(res, 200, { ids: [], total: 0 });
    let found;
    try {
      found = listTasks(readState(board), readRegistry(board), { text: q, limit: SEARCH_LIMIT });
    } catch (err) {
      if (err instanceof BoardError) return sendJson(res, 400, { error: err.message }); // a filter list_tasks refuses
      throw err;
    }
    return sendJson(res, 200, { ids: found.items.map((t) => t.id), total: found.total });
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const events = (req, res) => {
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return void res.end();
    res.on('error', () => {}); // a connection that drops mid-write; 'close' removes the client
    const beat = setInterval(() => push(res, ': heartbeat\n\n'), heartbeatMs);
    beat.unref();
    clients.add(res);
    res.on('close', () => {
      clearInterval(beat);
      clients.delete(res);
    });
    push(res, `retry: ${RETRY_MS}\n\n`);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const handle = async (req, res) => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : null;
    const hostHeader = req.headers.host;
    if (port == null || (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`)) return sendText(res, 403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const pathname = q === -1 ? url : url.slice(0, q);
    if (pathname === '/') return serveFile(res, path.join(uiDir, 'index.html'));
    if (pathname.startsWith('/ui/')) {
      const file = uiFile(uiDir, pathname.slice('/ui/'.length));
      return file ? serveFile(res, file) : notFound(res);
    }
    if (pathname === '/api/view') return sendJson(res, 200, view());
    if (pathname === '/api/search') return search(res, new URLSearchParams(q === -1 ? '' : url.slice(q + 1)).get('q') ?? '');
    if (pathname === '/api/ping') return sendJson(res, 200, { app: NAME, board: id });
    if (pathname === '/api/events') return events(req, res);
    const m = /^\/api\/task\/([^/]+)$/.exec(pathname);
    if (m) return task(res, m[1]);
    return notFound(res);
  };

  /** A handler's failure: logged, then answered with 500 (or the connection is cut when the answer had begun). */
  const fail = (req, res, err) => {
    try {
      logError(board, `dashboard ${(req.url ?? '').split('?')[0]}`, err);
      try {
        onError?.(err);
      } catch {
        // the callback's own failure changes nothing
      }
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'The dashboard could not answer this request; see errors.log in the board folder.' });
    } catch {
      res.destroy();
    }
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => fail(req, res, err));
  });
  const notify = (seq) => {
    const chunk = `event: change\ndata: ${Number.isFinite(seq) ? seq : ''}\n\n`;
    for (const res of clients) push(res, chunk);
  };
  const endEvents = () => {
    for (const res of clients) res.end();
    clients.clear();
  };
  Object.assign(server, { notify, endEvents });
  Object.defineProperty(server, 'eventClients', { get: () => clients.size });
  return /** @type {DashboardServer} */ (server);
}

/**
 * Starts the dashboard server on 127.0.0.1. Rejects when it cannot listen (a port in use).
 * It watches the board (watchBoard): every change sends the board's seq to the event streams.
 * close() stops watching, ends the event streams and every connection, then resolves once the
 * server has closed.
 * @param {DashboardOptions & { port?: number, watch?: false | import('./watch.js').WatchOptions }} opts
 *   port: 0 (default) for a free one; watch: watchBoard's options, or false for no watching
 * @returns {Promise<{ server: DashboardServer, url: string, port: number, close: () => Promise<void>, notify: (seq: number) => void }>}
 */
export function startDashboard({ port = 0, watch = {}, ...opts }) {
  const server = createDashboardServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', (err) => logError(opts.board, 'dashboard server', err));
      const actual = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
      const { board } = opts;
      const watcher = watch === false ? null : watchBoard(board, () => server.notify(readState(board).seq), watch);
      const close = () => new Promise((done) => {
        watcher?.close();
        server.endEvents();
        server.close(() => done(undefined));
        server.closeAllConnections();
      });
      resolve({ server, url: `http://127.0.0.1:${actual}/`, port: actual, close, notify: server.notify });
    });
  });
}
