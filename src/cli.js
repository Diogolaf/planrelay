#!/usr/bin/env node
import { NAME } from './name.js';

/**
 * The `agentboard` command (§3):
 * - `hook`: every Claude Code hook (§9). Reads the hook's JSON on stdin and prints the output.
 *   Fail-open: it always exits 0 and never throws, whatever the input.
 * - `mcp`: the agent tools (§8) over stdio, for the session's project.
 * - `repair`: rebuilds every snapshot from the event log (§6) of the board of the current folder.
 *
 * Each command loads only the modules it needs, so a hook call does not pay for the MCP server.
 */

const USAGE = `usage: ${NAME} <hook|mcp|repair>`;
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

const [command] = process.argv.slice(2);
if (command === 'hook') await hook();
else if (command === 'mcp') await mcp();
else if (command === 'repair') await repairCommand();
else if (command === '--help' || command === '-h' || command === 'help') console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 1;
}
