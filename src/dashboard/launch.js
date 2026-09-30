import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NAME } from '../name.js';
import { readJson, sleepSync, writeJsonAtomic } from '../core/fsx.js';
import { pidAlive } from '../core/mutex.js';
import { BoardError } from '../core/ops.js';

/**
 * Starting, finding and opening the dashboard, for the `dashboard` command and the `open_board`
 * tool (§8, §13). A running dashboard records itself in `dashboard.json` in the board folder:
 * `{ pid, port, startedAt, board }` (board: boardId, as /api/ping answers). A record counts only
 * while its process is alive. The dashboard's URL is always built here from the recorded port,
 * never read from the file.
 *
 * This module is loaded by the MCP server: the HTTP server (server.js) is imported only when a
 * dashboard is started in this process (serveDashboard).
 *
 * @typedef {import('../core/store.js').Board} Board
 * @typedef {{ pid: number, on: (event: string, fn: () => void) => unknown, exit: (code?: number) => void }} Proc
 */

const CLI = path.join(import.meta.dirname, '..', 'cli.js');
/** How long ensureDashboard waits for a new dashboard, and how often it looks. */
const START_TIMEOUT_MS = 5_000;
const START_POLL_MS = 100;
const DETACHED = Object.freeze({ detached: true, stdio: 'ignore', windowsHide: true });

/** @param {Board} board */
export const dashboardFile = (board) => path.join(board.dir, 'dashboard.json');

/** @param {number} port */
const urlOf = (port) => `http://127.0.0.1:${port}/`;

/**
 * The dashboard that dashboard.json records, while its process is alive: its pid and its URL, built
 * from the recorded port (a whole number from 1 to 65535). Null when the file is missing, unreadable
 * or malformed, or names a process that is gone.
 * @param {Board} board @param {(pid: number) => boolean} [alive]
 * @returns {{ pid: number, url: string } | null}
 */
export function runningDashboard(board, alive = pidAlive) {
  let rec;
  try {
    rec = readJson(dashboardFile(board), null);
  } catch {
    return null;
  }
  const pid = rec?.pid;
  const port = rec?.port;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return alive(pid) ? { pid, url: urlOf(port) } : null;
}

/** Removes dashboard.json while it still names `pid` (a newer dashboard's record is kept). Never throws. */
function forgetDashboard(board, pid) {
  try {
    if (readJson(dashboardFile(board), null)?.pid === pid) fs.rmSync(dashboardFile(board), { force: true });
  } catch {
    // the record stays; its process is gone, so the next start replaces it
  }
}

/**
 * Opens a URL in the default browser: `rundll32 url.dll,FileProtocolHandler` on Windows, `open` on
 * macOS, `xdg-open` elsewhere. Detached and ignored; never throws (the URL is printed or returned
 * anyway, so a missing opener costs nothing).
 * @param {string} url
 * @param {{ spawn?: typeof childProcess.spawn, platform?: NodeJS.Platform }} [io] tests replace them
 */
export function openBrowser(url, { spawn = childProcess.spawn, platform = process.platform } = {}) {
  /** @type {[string, string[]]} */
  let command = ['xdg-open', [url]];
  if (platform === 'win32') command = ['rundll32', ['url.dll,FileProtocolHandler', url]];
  else if (platform === 'darwin') command = ['open', [url]];
  try {
    const child = spawn(command[0], command[1], { ...DETACHED });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no opener: nothing to do
  }
}

/**
 * The dashboard of `board`, opened in the browser, for open_board. Synchronous, like MCP tool
 * handlers. A live recorded dashboard is reused; otherwise `agentboard dashboard` is started for
 * the board's folder, detached and without output, so it outlives this process and never writes to
 * the MCP server's stdout, and this waits up to 5 s for it to record itself.
 * @param {Board} board
 * @param {{ spawn?: typeof childProcess.spawn, open?: (url: string) => void, sleep?: (ms: number) => void,
 *   now?: () => number, alive?: (pid: number) => boolean }} [io] tests replace them
 * @returns {{ url: string, reused: boolean }}
 */
export function ensureDashboard(board, { spawn = childProcess.spawn, open = openBrowser, sleep = sleepSync, now = Date.now, alive = pidAlive } = {}) {
  const running = runningDashboard(board, alive);
  if (running) {
    open(running.url);
    return { url: running.url, reused: true };
  }
  const child = spawn(process.execPath, [CLI, 'dashboard', '--dir', board.repoRoot, '--no-open'], { ...DETACHED });
  child.on('error', () => {}); // a start that fails is reported by the timeout below
  child.unref();
  const end = now() + START_TIMEOUT_MS;
  for (;;) {
    // any live record will do: another session may have started one at the same moment
    const started = runningDashboard(board, alive);
    if (started) {
      open(started.url);
      return { url: started.url, reused: started.pid !== child.pid };
    }
    if (now() >= end) {
      throw new BoardError(`The dashboard did not start within ${START_TIMEOUT_MS / 1000} seconds. Tell the human, who can run `
        + `\`${NAME} dashboard\` (or \`node "${CLI}" dashboard\`) in a terminal in the project folder to see what goes wrong.`);
    }
    sleep(START_POLL_MS);
  }
}

/**
 * The `dashboard` command's work: reuses the live dashboard of the board, or starts one in this
 * process and records it in dashboard.json. SIGINT and SIGTERM close the server and exit with code
 * 0; the record is removed then and at any exit, while it still names this process.
 * @param {Board} board
 * @param {{ port?: number, proc?: Proc, now?: () => number, alive?: (pid: number) => boolean }} [opts]
 *   port: 0 (default) for a free one; proc: `process` (tests pass a stand-in)
 * @returns {Promise<{ url: string, reused: boolean }>}
 */
export async function serveDashboard(board, { port = 0, proc = process, now = Date.now, alive = pidAlive } = {}) {
  const running = runningDashboard(board, alive);
  if (running) return { url: running.url, reused: true };
  const { boardId, startDashboard } = await import('./server.js');
  const dash = await startDashboard({ board, port });
  const { pid } = proc;
  try {
    writeJsonAtomic(dashboardFile(board), { pid, port: dash.port, startedAt: now(), board: boardId(board) });
  } catch (err) {
    await dash.close(); // unrecorded, it would never be reused
    throw err;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    forgetDashboard(board, pid);
    dash.close().then(() => proc.exit(0));
  };
  proc.on('SIGINT', stop);
  proc.on('SIGTERM', stop);
  proc.on('exit', () => forgetDashboard(board, pid));
  return { url: dash.url, reused: false };
}
