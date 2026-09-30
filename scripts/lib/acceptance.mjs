// The scripted acceptance on a throwaway project (spec section 17): starting headless Claude Code
// sessions, reading their stream-json output, and the checks of the two scenarios. The command
// (scripts/acceptance.mjs) makes the project, runs the scenarios and prints the verdict.
//
// Real sessions draw on the account of whoever runs the script. So one run starts at most
// MAX_SESSIONS of them, every prompt has a time limit, and a session that overruns it is stopped
// together with every process it started. Tests replace the `claude` command with
// test/fixtures/fake-claude.mjs; nothing here starts a real session from a test run.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COLUMN_LABELS, columnOf } from '../../src/core/derive.js';
import { logHealth, readMessages, readRegistry, readState } from '../../src/core/store.js';
import { NAME } from '../../src/name.js';

/** @typedef {{ name: string, input: any, output: string, isError: boolean }} ToolCall */
/** @typedef {{ text: string, cost: number, tools: ToolCall[] }} Turn */
/** @typedef {{ name: string, ok: boolean, detail: string }} Check */
/**
 * The sessions of one run of the script: how many were started, and the ones still running.
 * @typedef {{ max: number, started: number, open: Set<{ stop: () => Promise<void> }> }} Run
 */
/**
 * What starts a session, besides the flags of claudeArgs.
 * cwd: the project folder; command: replaces `claude` (tests); env: the environment the child's is
 * made from (childEnv); timeoutMs: the limit for one prompt; transcript: a file that gets every
 * line the session prints (its stderr goes next to it, as `<name>.stderr.txt`); label: the
 * session's name in errors; run: the counter of started sessions (default: this process's).
 * @typedef {{ cwd: string, command?: string[], env?: Record<string, string | undefined>, timeoutMs?: number,
 *   transcript?: string | null, label?: string, run?: Run, pluginDir: string, mcpConfig: string, model: string,
 *   budgetUsd: number }} SessionOptions
 */

/** The sessions one run of the script may start: both scenarios together need five. */
export const MAX_SESSIONS = 5;
/** How long a session may take to answer one prompt. */
export const TURN_TIMEOUT_MS = 5 * 60_000;
/** How long a session may take to exit once its input is closed; then it is stopped. */
const EXIT_TIMEOUT_MS = 30_000;
/** How long a stopped session may take to go away before the runner stops waiting for it. */
const STOP_TIMEOUT_MS = 5_000;

/**
 * The board's tools, under both names its server can have: `agentboard` when it comes from
 * --mcp-config, `plugin_agentboard_agentboard` when the plugin starts it.
 */
const BOARD_TOOLS = [`mcp__${NAME}__*`, `mcp__plugin_${NAME}_${NAME}__*`];
/** The built-in tools a session may use without asking; it has no shell. */
const ALLOWED_TOOLS = [...BOARD_TOOLS, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'];
const DENIED_TOOLS = ['Bash', 'PowerShell'];
/** The tools that change a file (the lock applies to them). */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** The line the second agent of the pair scenario is asked to add, and must not get into the file. */
export const REFUSED_LINE = 'Tip: taste as you go.';

/** What each session is asked (spec section 17). The checks below expect exactly this work. */
export const PROMPTS = Object.freeze({
  soloFirst:
    "Create two tasks on the board for me: 'Add a pancake recipe to recipes.md' and 'Add a table of contents to README.md'. " +
    'Claim the first, do it, and complete it. Then claim the second, set a checklist with exactly two steps, do only the first step ' +
    'and mark it done. Then stop: do not complete or release the second task; the next session continues it.',
  soloSecond: 'Continue the task the board gave you and complete it.',
  pairAsk:
    "Create two tasks on the board for me: 'Add an ingredients section to recipes.md' and 'Write shopping.md from the ingredients', " +
    "where the second depends on the first. Claim the first. Add the heading '## Ingredients' to recipes.md. " +
    'Then ask me on the task whether to use metric or imperial units, and stop there.',
  pairRefused:
    `Claim task #2. Then append the line '${REFUSED_LINE}' to recipes.md. ` +
    'If the board or a tool refuses something, do not work around it and do not retry: tell me exactly what it said.',
  pairAnswer:
    'My answer to your question: metric. Record my answer on the board, add two ingredients in metric units under the heading, ' +
    'and complete the task.',
  pairShopping: 'Claim task #2, write shopping.md with the ingredients from recipes.md, and complete the task.',
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------------------------

/**
 * The flags of a headless session, without the command and without a prompt: the prompt always
 * goes through stdin.
 * - --setting-sources project,local keeps the user's own settings, hooks and plugins out.
 * - --strict-mcp-config keeps the account's connectors out; it drops the plugin's own server too,
 *   so the --mcp-config file declares it again (mcpConfigOf).
 * - A held session reads one JSON line per prompt (--input-format stream-json) and ends when its
 *   input closes.
 * @param {{ pluginDir: string, mcpConfig: string, model: string, budgetUsd: number, held?: boolean }} flags
 * @returns {string[]}
 */
export function claudeArgs({ pluginDir, mcpConfig, model, budgetUsd, held = false }) {
  return [
    '-p', '--model', model, '--plugin-dir', pluginDir,
    '--setting-sources', 'project,local',
    '--strict-mcp-config', '--mcp-config', mcpConfig,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...ALLOWED_TOOLS,
    '--disallowedTools', ...DENIED_TOOLS,
    '--output-format', 'stream-json', '--verbose',
    '--max-budget-usd', String(budgetUsd), '--no-session-persistence',
    ...(held ? ['--input-format', 'stream-json'] : []),
  ];
}

/** The account's variables, which a session needs to sign in; every other CLAUDE_* one belongs to the surrounding session. */
const isAccountVar = (key) => key === 'CLAUDE_CONFIG_DIR' || key === 'CLAUDE_CODE_OAUTH_TOKEN' || key.startsWith('CLAUDE_CODE_USE_');

/**
 * The environment of a session: `env` without CLAUDECODE and the CLAUDE_* variables of a Claude
 * Code session the script may run inside (session id, project folder, entry point), so the new
 * session has its own identity. The account's variables stay.
 * @param {Record<string, string | undefined>} [env] @returns {Record<string, string>}
 */
export function childEnv(env = process.env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const k = key.toUpperCase(); // Windows ignores the case of variable names
    if (value === undefined || k === 'CLAUDECODE' || (k.startsWith('CLAUDE_') && !isAccountVar(k))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The content of the --mcp-config file: the servers the plugin's manifest declares, with the
 * plugin's folder in place of ${CLAUDE_PLUGIN_ROOT} (forward slashes, as Claude Code fills it in).
 * @param {string} pluginDir the repository
 */
export function mcpConfigOf(pluginDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const root = path.resolve(pluginDir).split(path.sep).join('/');
  const fill = (v) => {
    if (typeof v === 'string') return v.replaceAll('${CLAUDE_PLUGIN_ROOT}', root);
    if (Array.isArray(v)) return v.map(fill);
    return isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
  };
  return { mcpServers: fill(manifest.mcpServers) };
}

/**
 * A command and its arguments as one Windows command line, each part quoted for cmd.exe and for
 * the program that reads it: backslashes before a closing quote are doubled, or they would escape
 * it. A quote, a percent sign or a line break cannot be passed safely and is refused; flags and
 * paths have none, and a prompt never goes here.
 * @param {string[]} argv
 */
export function windowsCommandLine(argv) {
  return argv.map((arg) => {
    if (/["%\r\n]/.test(arg)) throw new Error(`acceptance: ${JSON.stringify(arg)} cannot go on a Windows command line (a quote, a percent sign or a line break)`);
    return `"${arg.replace(/\\+$/, '$&$&')}"`;
  }).join(' ');
}

/**
 * Starts the session's process. On Windows `claude` is a .cmd file, which only a shell can run,
 * so the command and its flags go to it as one quoted line (windowsCommandLine). Elsewhere there
 * is no shell, and the process leads its own process group, so the whole group can be stopped at once.
 * @param {string[]} argv the command and its arguments
 */
function launch(argv, { cwd, env }) {
  /** @type {import('node:child_process').SpawnOptions} */
  const opts = { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (process.platform === 'win32') return spawn(windowsCommandLine(argv), { ...opts, shell: true });
  return spawn(argv[0], argv.slice(1), { ...opts, detached: true });
}

/**
 * Stops a session's process and everything it started. On Windows the child is the shell, and
 * ending only the shell would leave the session itself running, so taskkill ends the tree.
 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // the process group
  } catch {
    child.kill('SIGKILL');
  }
}

/** True when `promise` settles within `ms`. */
function settlesWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A failed session: `turn` is what it had printed of the prompt it was answering (its last text, tool calls, cost). */
export class SessionError extends Error {
  /** @param {string} message @param {Turn} turn */
  constructor(message, turn) {
    super(message);
    this.name = 'SessionError';
    this.turn = turn;
  }
}

/** A fresh counter of sessions; tests use their own, the script the one of its process. @returns {Run} */
export function newRun(max = MAX_SESSIONS) {
  return { max, started: 0, open: new Set() };
}

/** The run of this process. */
const RUN = newRun();

/**
 * The command that starts a session: `claude`, unless the caller gave one. A test run (node --test
 * sets NODE_TEST_CONTEXT) must give one: a forgotten stand-in would start real sessions.
 * @param {string[] | undefined} command
 */
function commandOf(command) {
  if (command !== undefined) return command;
  if (process.env.NODE_TEST_CONTEXT) throw new Error('acceptance: a test run never starts a real session; pass the stand-in as `command`');
  return ['claude'];
}

/**
 * Starts one session and returns its handle. Every start counts against the run's limit first.
 * @param {SessionOptions & { held: boolean }} opts
 */
function start({ cwd, command, env = process.env, timeoutMs = TURN_TIMEOUT_MS, transcript = null, label = 'session', run = RUN, held, ...flags }) {
  const argv = [...commandOf(command), ...claudeArgs({ ...flags, held })];
  if (run.started >= run.max) {
    throw new Error(`acceptance: refusing to start ${label}: this run has started ${run.started} sessions, and ${run.max} is the limit`);
  }
  run.started += 1;
  const child = launch(argv, { cwd, env: childEnv(env) });
  const stderrFile = transcript ? `${transcript.replace(/\.jsonl$/, '')}.stderr.txt` : null;

  /** The parsed stream lines of the prompt being answered. @type {any[]} */
  let events = [];
  /** The prompt being answered, until its `result` line. @type {{ resolve: (turn: Turn) => void, reject: (err: Error) => void } | null} */
  let waiting = null;
  /** How the process went away (error: it could not be started); null while it runs. @type {{ code: number | null, signal: string | null, error?: Error } | null} */
  let gone = null;
  let buf = '';
  /** @type {() => void} */
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = () => resolve(undefined); });

  const onLine = (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // not JSON (a warning, an empty line): it stays in the transcript
    }
    if (!isObj(ev)) return;
    events.push(ev);
    if (ev.type !== 'result' || !waiting) return;
    const { resolve, reject } = waiting;
    const turn = readTurn(events);
    waiting = null;
    events = [];
    const failed = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success');
    if (failed) reject(new SessionError(`${label}: the turn ended in an error (${String(ev.subtype ?? 'is_error')})`, turn));
    else resolve(turn);
  };

  const finish = (how) => {
    if (gone) return;
    gone = how;
    run.open.delete(handle);
    if (buf.trim()) onLine(buf); // a last line without a line end
    if (waiting) {
      const why = how.error
        ? `could not be started (${how.error.message})`
        : `the session exited (${how.signal ? `signal ${how.signal}` : `code ${how.code}`}) before it answered`;
      waiting.reject(new SessionError(`${label}: ${why}`, readTurn(events)));
      waiting = null;
    }
    markClosed();
  };
  child.on('error', (error) => finish({ code: null, signal: null, error }));
  child.on('close', (code, signal) => finish({ code, signal }));
  child.stdin.on('error', () => {}); // the process went away while a prompt was being written: `close` reports it
  child.stdout.setEncoding('utf8'); // decoded as a stream: a character may be split between two chunks
  child.stdout.on('data', (chunk) => {
    if (transcript) fs.appendFileSync(transcript, chunk);
    const parts = (buf + chunk).split('\n');
    buf = parts.pop() ?? '';
    for (const line of parts) onLine(line);
  });
  child.stderr.on('data', (chunk) => {
    if (stderrFile) fs.appendFileSync(stderrFile, chunk);
  });

  /** Stops the session's processes and waits until they are gone. */
  const stop = async () => {
    if (gone) return;
    killTree(child);
    await settlesWithin(closed, STOP_TIMEOUT_MS);
  };

  /** Sends one prompt and resolves its turn; rejects with a SessionError. @param {string} prompt @returns {Promise<Turn>} */
  const send = (prompt) => new Promise((resolve, reject) => {
    if (gone) return reject(new SessionError(`${label}: the session has ended`, readTurn([])));
    if (waiting) return reject(new Error(`${label}: the previous prompt has no answer yet`));
    const timer = setTimeout(() => {
      const turn = readTurn(events);
      waiting = null; // the stop below is reported as the time limit, not as an early exit
      stop().then(() => reject(new SessionError(`${label}: no answer within ${Math.round(timeoutMs / 1000)} s; the session was stopped`, turn)));
    }, timeoutMs);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    waiting = { resolve: settle(resolve), reject: settle(reject) };
    if (held) {
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`);
    } else {
      child.stdin.end(prompt);
    }
  });

  /** Closes the session's input, which ends it, and waits for its exit; a session that stays is stopped. */
  const close = async () => {
    if (gone) return;
    child.stdin.end();
    if (!(await settlesWithin(closed, EXIT_TIMEOUT_MS))) await stop();
  };

  const handle = { send, close, stop };
  run.open.add(handle);
  return handle;
}

/**
 * One-shot session: the prompt is the whole of its input. Resolves its single turn once the
 * process has exited; rejects with a SessionError when the turn ends in an error, the process
 * exits first or the time limit passes. `command` replaces `claude` in tests.
 * @param {SessionOptions & { prompt: string }} opts @returns {Promise<Turn>}
 */
export async function runSession({ prompt, ...opts }) {
  const session = start({ ...opts, held: false });
  try {
    return await session.send(prompt);
  } finally {
    await session.close();
  }
}

/**
 * A session kept alive, for a scenario that needs two live agents: `send(prompt)` resolves that
 * prompt's turn (the time limit applies to each), `close()` ends the session and waits for its exit.
 * @param {SessionOptions} opts
 * @returns {Promise<{ send: (prompt: string) => Promise<Turn>, close: () => Promise<void> }>}
 */
export async function openSession(opts) {
  const { send, close } = start({ ...opts, held: true });
  return { send, close };
}

/** Stops every session of the run that is still running. The script calls it whatever happened. */
export async function closeAll(run = RUN) {
  await Promise.all([...run.open].map((session) => session.stop()));
}

// ---------------------------------------------------------------------------------------------
// Reading the stream
// ---------------------------------------------------------------------------------------------

/** The text of a tool result: a string, or the text blocks of a list. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/**
 * One turn from its stream-json lines (already parsed): the tool calls of the `assistant` lines,
 * each with the result a `user` line gave it, and the turn's last text: the `result` line's, else
 * the last text the assistant wrote. Lines of other types, fields it does not know and blocks in
 * another shape are skipped.
 * @param {unknown[]} events @returns {Turn}
 */
export function readTurn(events) {
  /** @type {ToolCall[]} */
  const tools = [];
  /** @type {Map<string, ToolCall>} */
  const byId = new Map();
  let said = '';
  let result = null;
  for (const ev of events) {
    if (!isObj(ev)) continue;
    if (ev.type === 'result') result = ev;
    const content = isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content.filter(isObj) : [];
    for (const block of content) {
      if (ev.type === 'assistant' && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) said = block.text;
      if (ev.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const call = { name: block.name, input: block.input ?? null, output: '', isError: false };
        tools.push(call);
        if (typeof block.id === 'string') byId.set(block.id, call);
      }
      if (ev.type === 'user' && block.type === 'tool_result' && byId.has(block.tool_use_id)) {
        Object.assign(byId.get(block.tool_use_id), { output: resultText(block.content), isError: block.is_error === true });
      }
    }
  }
  const text = typeof result?.result === 'string' && result.result !== '' ? result.result : said;
  return { text, cost: Number.isFinite(result?.total_cost_usd) ? result.total_cost_usd : 0, tools };
}

/**
 * The board tool a call used (`claim_task`), whatever its server is called in that session
 * (`mcp__agentboard__claim_task`, `mcp__plugin_agentboard_agentboard__claim_task`); '' for any other tool.
 * @param {string} name
 */
export function boardTool(name) {
  return name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : '';
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

/** A check: passed when `problem` is empty, else failed with it as the detail. @returns {Check} */
const check = (name, problem) => ({ name, ok: !problem, detail: problem || '' });

/** A text on one line, cut to about 120 characters, for a detail. */
function short(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t || '(nothing)';
}

/** Every event of the board's log, in order; lines that do not parse are left to logHealth. */
function readEvents(board) {
  let text = '';
  try {
    text = fs.readFileSync(board.files.events, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      const ev = JSON.parse(line);
      return isObj(ev) ? [ev] : [];
    } catch {
      return [];
    }
  });
}

/** The events of one kind about one task. */
const eventsOf = (events, type, id) => events.filter((e) => e.type === type && isObj(e.data) && e.data.id === id);

const taskAt = (state, id) => (Object.hasOwn(state.tasks, id) ? state.tasks[id] : null);
/** "In progress", "Blocked"...: where a task that is not done stands. */
const columnName = (state, t) => COLUMN_LABELS[columnOf(t, state.tasks)] ?? 'not done';
/** An agent's name and the start of its id, which tells two sessions with one name apart. */
const who = (reg, id, name) => `${reg.agents[id]?.name ?? name ?? 'an agent'} (${String(id).slice(0, 8)})`;
/** A project file's text, or null when it does not exist. Names compare without case, like the lock does. */
function fileText(files, name) {
  const key = Object.keys(files).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : files[key];
}

/** Task `id` was asked for by the human and is Done with a summary. */
function doneForHuman(state, id) {
  const t = taskAt(state, id);
  if (!t) return `#${id} does not exist`;
  if (t.origin !== 'human') return `#${id} is an agent's suggestion, not a request of the human`;
  if (!t.done) return `#${id} is ${columnName(state, t)}`;
  return t.summary ? '' : `#${id} has no summary`;
}

/** Task `id` was claimed by one agent and completed by another, and nobody released it in between. */
function inherited(events, id) {
  const [claim] = eventsOf(events, 'task.claimed', id);
  const [done] = eventsOf(events, 'task.completed', id);
  if (!claim) return `nobody claimed #${id}`;
  if (!done) return `#${id} was not completed`;
  if (done.actor === claim.data.agent) return `the session that first claimed #${id} also completed it`;
  const release = eventsOf(events, 'task.released', id).find((e) => e.seq > claim.seq && e.seq < done.seq);
  return release ? `#${id} was released (${release.data.reason ?? 'no reason'}) between its first claim and its completion` : '';
}

function checklistDone(t, id) {
  if (!t) return `#${id} does not exist`;
  const done = t.checklist.filter((i) => i.done).length;
  if (t.checklist.length < 2) return `its checklist has ${t.checklist.length} item${t.checklist.length === 1 ? '' : 's'}`;
  return done === t.checklist.length ? '' : `${done} of its ${t.checklist.length} items are done`;
}

/**
 * Task `id` lists the files it touched, all of them exist, and `file` is among them and holds the work.
 * @param {{ file: string, holds: RegExp, lacks: string }} work lacks: what to say when the file does not match `holds`
 */
function worked(t, id, { file, holds, lacks }, files) {
  if (!t) return `#${id} does not exist`;
  if (!t.files.length) return `#${id} lists no touched file`;
  const missing = t.files.find((f) => fileText(files, f.path) === null);
  if (missing) return `#${id} lists ${missing.path}, which does not exist`;
  if (!t.files.some((f) => f.path.toLowerCase() === file.toLowerCase())) return `#${id} lists ${t.files.map((f) => f.path).join(', ')}, not ${file}`;
  return holds.test(fileText(files, file)) ? '' : `${file} ${lacks}`;
}

/** What each task of the solo scenario leaves in its file. A table of contents is a heading that says so, or links to headings. */
const SOLO_WORK = {
  1: { file: 'recipes.md', holds: /pancake/i, lacks: 'does not mention a pancake' },
  2: { file: 'README.md', holds: /contents|\]\(#/i, lacks: 'has no table of contents' },
};

/** The board logged no internal error (no errors.log) and its log has no malformed line. @returns {Check} */
function healthy(board) {
  const problems = [];
  if (fs.existsSync(board.files.errors)) problems.push(`the board wrote an errors.log (${board.files.errors})`);
  const { badLines } = logHealth(board);
  if (badLines) problems.push(`events.jsonl has ${badLines} malformed line${badLines === 1 ? '' : 's'}`);
  return check('the board logged no internal error and no malformed line', problems.join('; '));
}

/**
 * The solo scenario: one agent, two sessions (PROMPTS.soloFirst, PROMPTS.soloSecond).
 * @param {{ board: import('../../src/core/store.js').Board, turns?: Record<string, Turn[]>, files: Record<string, string> }} run
 *   board: openBoard(project); files: the project's files by name; turns: not needed here
 * @returns {Check[]}
 */
export function checkSolo({ board, files }) {
  const state = readState(board);
  const events = readEvents(board);
  const both = (problems) => problems.filter(Boolean).join('; ');
  return [
    check('tasks #1 and #2 were requested by the human and are Done with a summary', both([doneForHuman(state, 1), doneForHuman(state, 2)])),
    check('#2 was claimed in the first session and completed by another, with no release in between (the claim was inherited)', inherited(events, 2)),
    check('#2 has a checklist of at least two items, all done', checklistDone(taskAt(state, 2), 2)),
    check('each task lists the files it touched, and they hold the work', both([1, 2].map((id) => worked(taskAt(state, id), id, SOLO_WORK[id], files)))),
    healthy(board),
  ];
}

/**
 * The pair scenario: agent A (held open), then B and C while A lives (PROMPTS.pair*).
 * @param {{ board: import('../../src/core/store.js').Board, turns: Record<string, Turn[]>, files: Record<string, string> }} run
 *   turns: the turns of sessions `A`, `B` and `C`
 * @returns {Check[]}
 */
export function checkPair({ board, turns, files }) {
  const state = readState(board);
  const reg = readRegistry(board);
  const events = readEvents(board);
  const [t1, t2] = [taskAt(state, 1), taskAt(state, 2)];
  /** The first agent: the one that put #1 on the board. Its name comes from the registry. */
  const first = t1 ? (t1.origin === 'human' ? t1.requestedVia : t1.createdBy) : null;
  const firstName = first ? reg.agents[first]?.name ?? t1.requestedViaName ?? t1.createdByName : null;
  const callsOfB = (turns.B ?? []).flatMap((t) => t.tools);

  const depends = () => {
    if (!t2) return '#2 does not exist';
    return t2.dependsOn.includes(1) ? '' : `#2 depends on ${t2.dependsOn.map((d) => `#${d}`).join(', ') || 'nothing'}`;
  };
  const claimRefused = () => {
    const claims = (turns.B?.[0]?.tools ?? []).filter((c) => boardTool(c.name) === 'claim_task');
    if (!claims.length) return 'session B made no claim_task call in its first turn';
    return claims.some((c) => c.output.includes('#2 waits on #1')) ? '' : `claim_task answered: ${short(claims[0].output)}`;
  };
  const editRefused = () => {
    if (!firstName) return 'nobody put #1 on the board, so there is no first agent to name';
    const edits = callsOfB.filter((c) => EDIT_TOOLS.has(c.name) && /(^|[\\/])recipes\.md$/i.test(String(c.input?.file_path ?? '')));
    const refused = edits.filter((c) => c.isError);
    if (!edits.length) return 'session B made no Edit or Write call on recipes.md';
    if (!refused.length) return 'its edit of recipes.md was not refused';
    if (!refused.some((c) => c.output.includes(firstName))) return `the refusal does not name ${firstName}: ${short(refused[0].output)}`;
    return (fileText(files, 'recipes.md') ?? '').includes(REFUSED_LINE) ? 'recipes.md holds the refused line' : '';
  };
  const answered = () => {
    const messages = readMessages(board, 1);
    const questions = messages.filter((m) => m.kind === 'question' && m.to === 'human');
    if (!questions.length) return `#1 has no question to the human (its messages: ${messages.map((m) => m.kind).join(', ') || 'none'})`;
    const answer = messages.find((m) => m.kind === 'answer' && questions.some((q) => q.id === m.replyTo));
    if (!answer) return `question ${questions[0].id} has no answer`;
    return answer.relayedFromHuman === true ? '' : `answer ${answer.id} is not marked as relayed from the human`;
  };
  const order = () => {
    if (!t1 || !t2) return `#${t1 ? 2 : 1} does not exist`;
    if (!t1.done) return `#1 is ${columnName(state, t1)}`;
    if (t1.completedBy !== first) return `#1 was completed by ${who(reg, t1.completedBy, t1.completedByName)}, not by ${who(reg, first, firstName)}, who created it`;
    const [done] = eventsOf(events, 'task.completed', 1);
    const [claim] = eventsOf(events, 'task.claimed', 2);
    if (!claim) return 'nobody claimed #2';
    if (!done || claim.seq < done.seq) return `#2 was claimed (event ${claim.seq}) before #1 was completed`;
    if (!t2.done) return `#2 is ${columnName(state, t2)}`;
    return t2.completedBy === first ? `#2 was completed by ${who(reg, first, firstName)} too, not by another agent` : '';
  };
  return [
    check('#2 depends on #1', depends()),
    check("the second agent's claim of #2 was refused while #1 was open", claimRefused()),
    check("the second agent's edit of recipes.md was refused, the refusal names the first agent, and its line is not in the file", editRefused()),
    check('#1 has a question to the human and an answer relayed from the human', answered()),
    check('#1 is Done by the first agent; #2 was claimed after that and is Done by another agent', order()),
    healthy(board),
  ];
}
