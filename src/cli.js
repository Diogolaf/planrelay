#!/usr/bin/env node
import { NAME } from './name.js';

/**
 * The `planrelay` command (§3):
 * - `hook`: every Claude Code hook (§9). Reads the hook's JSON on stdin and prints the output.
 *   Fail-open: it always exits 0 and never throws, whatever the input.
 * - `mcp`: the agent tools (§8) over stdio, for the session's project.
 * - `repair`: rebuilds every snapshot from the event log (§6) of the board of the current folder.
 * - `dashboard [--port N] [--dir PATH] [--no-open] [--idle-exit MINUTES]`: serves the dashboard
 *   (§13) of the board of PATH, else of the current folder, until Ctrl+C (or, with --idle-exit, until
 *   no browser tab has been on it for that long), and opens it in the browser. A dashboard already
 *   running for that board is reused: its URL is printed (and opened), and the command exits.
 *
 * Each command loads only the modules it needs, so a hook call does not pay for the MCP server.
 */

const USAGE = `usage: ${NAME} <hook|mcp|repair|dashboard>`;
const DASHBOARD_USAGE = `usage: ${NAME} dashboard [--port N] [--dir PATH] [--no-open] [--idle-exit MINUTES]`;
/** repair names at most this many skipped lines. */
const LINES_NAMED = 20;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** All of stdin as text, decoded once (a chunk can end inside a multi-byte character). */
async function readStdin() {
  if (process.stdin.isTTY) return ''; // run by hand in a terminal: no hook input is coming
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function hook() {
  // the host may stop reading (a timeout, the session closing): a failed write must not crash
  process.stdout.on('error', () => {});
  try {
    let input = null;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      input = null; // not JSON: runHook prints nothing for it
    }
    const { runHook } = await import('./hooks/run.js');
    const out = runHook(input);
    if (out) process.stdout.write(out);
  } catch {
    // fail-open (§9): runHook logs its own failures; nothing else may stop the agent
  }
  process.exitCode = 0;
}

async function mcp() {
  const { startMcpServer } = await import('./mcp/tools.js');
  startMcpServer();
}

async function repairCommand() {
  const { openBoard, repair } = await import('./core/store.js');
  try {
    const board = openBoard(process.cwd(), { projectDir: process.env.CLAUDE_PROJECT_DIR });
    const { bad, state } = repair(board);
    let skipped = '';
    if (bad.length) {
      const more = bad.length > LINES_NAMED ? ` and ${bad.length - LINES_NAMED} more` : '';
      skipped = `; skipped malformed ${bad.length === 1 ? 'line' : 'lines'} ${bad.slice(0, LINES_NAMED).join(', ')}${more}`;
    }
    const tasks = plural(Object.keys(state.tasks).length, 'task');
    console.log(`${NAME}: rebuilt ${tasks} from ${plural(state.seq, 'event')} (board: ${board.dir})${skipped}.`);
  } catch (err) {
    console.error(`${NAME}: repair failed: ${/** @type {any} */ (err)?.message ?? err}`);
    process.exitCode = 1;
  }
}

/**
 * The options of `dashboard`, or null when they are not usable: an unknown option, an argument,
 * a port that is not a whole number from 0 to 65535, or an idle time that is not a number of minutes
 * above 0 (decimals allowed).
 * @param {string[]} args
 * @returns {Promise<{ port: number, dir: string | undefined, open: boolean, idleMs: number | null } | null>}
 */
async function dashboardOptions(args) {
  const { parseArgs } = await import('node:util');
  let values;
  try {
    ({ values } = parseArgs({
      args, options: { port: { type: 'string' }, dir: { type: 'string' }, 'no-open': { type: 'boolean' }, 'idle-exit': { type: 'string' } },
    }));
  } catch {
    return null;
  }
  const port = values.port === undefined ? 0 : /^\d{1,5}$/.test(values.port) ? Number(values.port) : NaN;
  if (!(port <= 65535)) return null;
  const minutes = values['idle-exit'];
  // at most 4 digits: a timer longer than 24.8 days would fire at once
  const idleMs = minutes === undefined ? null : /^\d{1,4}(\.\d{1,6})?$/.test(minutes) ? Number(minutes) * 60_000 : NaN;
  if (idleMs !== null && !(idleMs > 0)) return null;
  return { port, dir: values.dir, open: values['no-open'] !== true, idleMs };
}

async function dashboardCommand(args) {
  const opts = await dashboardOptions(args);
  if (!opts) {
    console.error(DASHBOARD_USAGE);
    process.exitCode = 1;
    return;
  }
  const [fs, { openBoard }, { openBrowser, serveDashboard }] = await Promise.all([
    import('node:fs'), import('./core/store.js'), import('./dashboard/launch.js'),
  ]);
  try {
    if (opts.dir !== undefined && !fs.statSync(opts.dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${opts.dir} is not a folder`);
    const board = opts.dir !== undefined ? openBoard(opts.dir) : openBoard(process.cwd(), { projectDir: process.env.CLAUDE_PROJECT_DIR });
    const { url, reused } = await serveDashboard(board, { port: opts.port, idleMs: opts.idleMs });
    console.log(reused
      ? `${NAME} dashboard for ${board.projectName} is already running: ${url}`
      : `${NAME} dashboard for ${board.projectName}: ${url} (Ctrl+C to stop)`);
    if (opts.open) openBrowser(url);
  } catch (err) {
    console.error(`${NAME}: dashboard failed: ${/** @type {any} */ (err)?.message ?? err}`);
    process.exitCode = 1;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'hook') await hook();
else if (command === 'mcp') await mcp();
else if (command === 'repair') await repairCommand();
else if (command === 'dashboard') await dashboardCommand(rest);
else if (command === '--help' || command === '-h' || command === 'help') console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 1;
}
