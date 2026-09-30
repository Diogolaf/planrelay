import fs from 'node:fs';
import { currentHost, endAgent, getAgent, hostPid, touchAgent } from '../core/agents.js';
import { rulesPath } from '../core/config.js';
import { lockConflict, recordTouch } from '../core/locks.js';
import { inheritClaim, maintenance } from '../core/maintenance.js';
import { claimedBy, syncChecklist, touchTaskFile } from '../core/ops.js';
import { currentBranch, lockKey, samePath, toRepoPath } from '../core/paths.js';
import { whatsNew } from '../core/queries.js';
import { snippet } from '../core/reduce.js';
import { logError, openBoard, readRegistry, readState, transact } from '../core/store.js';
import { formatBrief, formatPings, wrapBoardData } from './format.js';

/**
 * The single entry point of every Claude Code hook (§9). It reads the host's JSON input and returns
 * the text to print. It never throws: an internal error is logged to errors.log and prints nothing
 * (§16), so a hook can never block the agent, except through an intentional lock denial.
 *
 * @typedef {import('../core/store.js').Board} Board
 * @typedef {import('../core/agents.js').Agent} Agent
 * @typedef {import('./format.js').PingResult} PingResult
 * @typedef {{ board: Board, input: Record<string, any>, id: string, folder: string,
 *   env: Record<string, string | undefined>, host: string, now: number }} HookCall
 *   id: the session id; folder: the agent's folder, the worktree root (§6); host: currentHost()
 */

/** The file-editing tools the lock and the file record apply to (hooks/hooks.json matches them). */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Hooks never wait long for the board lock: on contention they give up and fail open. */
const HOOK_LOCK_TIMEOUT_MS = 2000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A board sequence number: a whole number of 0 or more. */
const isSeq = (v) => Number.isSafeInteger(v) && v >= 0;

function contextOutput(event, text) {
  return text ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) : '';
}

/** The edited file as a repo-relative path, or null: no usable path, or a file outside the repository (scratch files, temp folders). */
function repoFile(board, input) {
  const ti = isObj(input.tool_input) ? input.tool_input : {};
  const file = typeof ti.file_path === 'string' ? ti.file_path : ti.notebook_path;
  if (typeof file !== 'string' || file === '') return null;
  return toRepoPath(board.repoRoot, file) || null; // '' is the root itself, not a file
}

/**
 * Moves the agent's cursor to `seq`, the board sequence number it has now been shown up to (never a
 * time, §5 Agent), and keeps the previous cursor in prevCursor, so whats_new can show a batch that
 * overflowed the ping cap again. Returns the previous cursor: the pings are the messages after it.
 * An agent without a usable cursor starts at `seq`, so it is never shown older messages.
 * @param {Agent} agent @param {number} seq
 */
function advanceCursor(agent, seq) {
  const since = isSeq(agent.cursor) ? agent.cursor : seq;
  agent.prevCursor = since;
  agent.cursor = seq;
  return since;
}

/** Housekeeping for transact's `before` (§10): it runs first, and its events are applied before the operation. */
function housekeeping(board, host) {
  return (state, reg, now) => maintenance(state, reg, board.config, now, { host });
}

/** transact options for every hook write. */
const writeOpts = ({ board, host, now }) => ({ now, timeoutMs: HOOK_LOCK_TIMEOUT_MS, before: housekeeping(board, host) });

/** Registers or refreshes the calling agent, with its host process (hostPid). `extra` adds fields such as branch. @param {HookCall} h */
function touch(h, reg, seq, extra = {}) {
  return touchAgent(reg, { id: h.id, folder: h.folder, pid: hostPid(h.env), host: h.host, seq, ...extra }, h.now);
}

/**
 * The sessions a starting session replaces, whose updates since their own cursor it is shown (§9):
 * the most recently ended agent of the same host process in the same folder (/clear: its
 * SessionEnd, or this session's touch, ended it), and the gone holder of the claim it inherits
 * (`events`; `state` is the board before them). Runs after touch. @param {HookCall} h
 * @returns {{ id: string, cursor: number | undefined }[]}
 */
function replacedSessions(h, state, reg, events) {
  const pid = hostPid(h.env);
  const endedAt = (a) => (Number.isFinite(a.endedAt) ? a.endedAt : -Infinity);
  const [same] = Object.entries(reg.agents)
    .filter(([key, a]) => key !== h.id && a.endedAt != null && pid !== null && a.pid === pid && a.host === h.host)
    .sort(([, x], [, y]) => endedAt(y) - endedAt(x));
  const claim = events.find((e) => e.type === 'task.claimed');
  const ids = [same && samePath(same[1].folder, h.folder) ? same[0] : null, claim ? state.tasks[claim.data.id]?.assignee : null];
  return [...new Set(ids)].filter((x) => getAgent(reg, x)).map((x) => ({ id: x, cursor: reg.agents[x].cursor }));
}

/** Two ping lists as one, oldest first, each message once. @param {PingResult} a @param {PingResult} b @returns {PingResult} */
function mergePings(a, b) {
  const seen = new Set(a.items.map((p) => p.message.id));
  const items = [...a.items, ...b.items.filter((p) => !seen.has(p.message.id))].sort((x, y) => x.message.seq - y.message.seq);
  return { items, olderDropped: a.olderDropped || b.olderDropped };
}

/**
 * SessionStart: registers the agent, inherits a claim a gone agent left in this folder (§10) and
 * returns the brief. Only a new session inherits: an agent that was already registered and live
 * (SessionStart after a compaction keeps the session id) never does, whatever the `source`. Its
 * cursor ends after its own inheritance events, so it is never pinged about them. The brief's
 * updates also bring what the sessions it replaces had not been shown (replacedSessions), such
 * as an answer that came after their last prompt, and every question to them that is still open
 * (from the message ring), shown or not; its cursor is past those too, so its first prompt does
 * not repeat them. @param {HookCall} h
 */
function sessionStart(h) {
  const { board, id, folder } = h;
  const { state, result } = transact(board, (state, reg) => {
    const known = getAgent(reg, id);
    const wasLive = known !== undefined && known.endedAt == null;
    const fresh = !isSeq(known?.cursor);
    const agent = touch(h, reg, state.seq, { branch: currentBranch(board.gitDir) });
    const events = wasLive ? [] : inheritClaim(state, reg, id, folder);
    const replaced = wasLive ? [] : replacedSessions(h, state, reg, events);
    // The events returned here take the next sequence numbers.
    const upTo = state.seq + events.length;
    if (fresh) agent.cursor = upTo; // a new agent starts after its own inheritance
    const since = advanceCursor(agent, upTo);
    return { events, registry: reg, result: { reg, since, name: agent.name, replaced } };
  }, writeOpts(h));
  const pings = result.replaced.reduce((all, r) => {
    // every question to it that is still open, even one it was shown: its conversation is gone
    const open = whatsNew(state, result.reg, r.id, { afterSeq: 0 }).items.filter((p) => p.reason === 'question');
    return mergePings(mergePings(all, whatsNew(state, result.reg, r.id, { afterSeq: r.cursor })), { items: open, olderDropped: false });
  }, whatsNew(state, result.reg, id, { afterSeq: result.since }));
  const rules = rulesPath(board.configRoot);
  return contextOutput('SessionStart', formatBrief({
    agentName: result.name,
    projectName: board.projectName,
    state,
    reg: result.reg,
    agentId: id,
    pings,
    maxPings: board.config.maxPings,
    rulesFile: fs.existsSync(rules) ? rules : null,
    configProblems: board.configProblems,
  }));
}

/** UserPromptSubmit: the pings since the agent's cursor, which then moves to the end of the board. @param {HookCall} h */
function promptSubmit(h) {
  const { board, id } = h;
  const { state, result } = transact(board, (state, reg) => {
    const agent = touch(h, reg, state.seq, { branch: currentBranch(board.gitDir) });
    const since = advanceCursor(agent, state.seq);
    return { registry: reg, result: { reg, since } };
  }, writeOpts(h));
  const pings = whatsNew(state, result.reg, id, { afterSeq: result.since });
  return contextOutput('UserPromptSubmit', formatPings(pings, board.config.maxPings));
}

/** PreToolUse: denies an edit that would collide with another agent's recent work (§10). Reads only. @param {HookCall} h */
function preToolUse({ board, input, id, now }) {
  if (!EDIT_TOOLS.has(input.tool_name)) return '';
  const file = repoFile(board, input);
  if (!file) return '';
  const state = readState(board);
  const hit = lockConflict({
    reg: readRegistry(board), cfg: board.config, now, agentId: id, taskId: claimedBy(state, id)?.id ?? null, file: lockKey(file),
  });
  if (!hit) return '';
  const name = hit.agent.name;
  const task = hit.task != null && Object.hasOwn(state.tasks, hit.task) ? state.tasks[hit.task] : null;
  let reason =
    `${file} is being edited by ${name}${task ? ` on #${task.id}` : ''}. To avoid a conflict, ask ${name} with post_message ` +
    `(kind "question", to "${name}") on your task, or work on something else and try again later.`;
  // the title is board text: fenced as data like everything else agents are shown (§9)
  if (task) reason += `\n${wrapBoardData([`#${task.id} ${snippet(task.title)}`])}`;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

/**
 * The todo list as checklist items, or null when it is not in a shape this version knows (a
 * newer host format): then the checklist is left alone rather than emptied.
 */
function todoItems(todos) {
  if (!Array.isArray(todos)) return null;
  if (todos.length && !todos.some((t) => typeof t?.content === 'string')) return null;
  return todos.map((t) => ({ text: t?.content, done: t?.status === 'completed' }));
}

/** PostToolUse: records an edited file (§9, §10) or mirrors the todo list into the claimed task. @param {HookCall} h */
function postToolUse(h) {
  const { board, input, id, now } = h;
  const tool = input.tool_name;
  const todo = tool === 'TodoWrite';
  if (!todo && !EDIT_TOOLS.has(tool)) return '';
  transact(board, (state, reg) => {
    touch(h, reg, state.seq);
    const ctx = { state, reg, cfg: board.config, agentId: id, now };
    const events = [];
    if (todo) {
      const items = todoItems(input.tool_input?.todos);
      if (items) events.push(...syncChecklist(ctx, items).events);
    } else {
      const file = repoFile(board, input);
      if (file) {
        recordTouch(reg, { agentId: id, taskId: claimedBy(state, id)?.id ?? null, file: lockKey(file), now });
        events.push(...touchTaskFile(ctx, file).events);
      }
    }
    return { events, registry: reg };
  }, writeOpts(h));
  return '';
}

/** SessionEnd: the agent is gone; its claim stays with the folder (§10). @param {HookCall} h */
function sessionEnd(h) {
  transact(h.board, (state, reg) => {
    endAgent(reg, h.id, h.now);
    return { registry: reg };
  }, writeOpts(h));
  return '';
}

const HANDLERS = {
  SessionStart: sessionStart,
  UserPromptSubmit: promptSubmit,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  SessionEnd: sessionEnd,
};

/**
 * Handles one hook call (§9). Never throws; failures are logged and produce no output. Input it
 * does not recognize (another event, no session id, fields in an unknown shape) prints nothing.
 * @param {unknown} input the JSON the host sent on stdin
 * @param {{ env?: Record<string, string | undefined>, now?: number, home?: string }} [opts]
 * @returns {string} what to print on stdout ('' for nothing)
 */
export function runHook(input, opts = {}) {
  /** @type {Board | null} */
  let board = null;
  let event = '';
  try {
    if (!isObj(input)) return '';
    const i = /** @type {Record<string, any>} */ (input);
    event = typeof i.hook_event_name === 'string' && Object.hasOwn(HANDLERS, i.hook_event_name) ? i.hook_event_name : '';
    if (!event || typeof i.session_id !== 'string' || i.session_id === '') return '';
    const env = opts?.env ?? process.env;
    const cwd = typeof i.cwd === 'string' && i.cwd !== '' ? i.cwd : process.cwd();
    board = openBoard(cwd, { home: opts?.home, projectDir: env.CLAUDE_PROJECT_DIR, env });
    // The agent's folder is the worktree root, never a subfolder it cd'ed into (§6).
    const now = opts?.now ?? Date.now();
    return HANDLERS[event]({ board, input: i, id: i.session_id, folder: board.repoRoot, env, host: currentHost(env), now });
  } catch (err) {
    if (board) logError(board, `hook ${event}`, err);
    return '';
  }
}
