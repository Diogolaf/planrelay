import fs from 'node:fs';
import path from 'node:path';
import { NAME } from '../name.js';
import { readConfig } from './config.js';
import { appendLine, fileSize, readJson, readLines, retryWhileBusy, writeFileAtomic, writeJsonAtomic } from './fsx.js';
import { withLock } from './mutex.js';
import { resolveBoard } from './paths.js';
import { applyEvent, emptyState, isEvent, SCHEMA } from './reduce.js';

/** @typedef {import('./reduce.js').BoardState} BoardState */
/** @typedef {import('./reduce.js').BoardEvent} BoardEvent */
/**
 * @typedef {{
 *   agents: Record<string, any>,
 *   activity: Record<number, number>,
 *   touches: Record<string, { agent: string, task: number | null, at: number }>
 * }} Registry
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} cwd @param {{ home?: string, projectDir?: string, env?: Record<string, string | undefined> }} [opts] */
export function openBoard(cwd, opts = {}) {
  const loc = resolveBoard(cwd, opts);
  const dir = loc.boardDir;
  // Config comes from the main worktree (loc.configRoot) and never throws; problems go to the session brief (§7).
  const { config, problems } = readConfig(loc.configRoot);
  return {
    ...loc,
    dir,
    cwd: path.resolve(cwd),
    config,
    configProblems: problems,
    files: {
      events: path.join(dir, 'events.jsonl'),
      state: path.join(dir, 'state', 'board.json'),
      messagesDir: path.join(dir, 'state', 'messages'),
      agents: path.join(dir, 'agents.json'),
      errors: path.join(dir, 'errors.log'),
    },
  };
}
/** @typedef {ReturnType<typeof openBoard>} Board */

export function messagesFile(board, taskId) {
  return path.join(board.files.messagesDir, `${taskId}.jsonl`);
}

/** @returns {Registry} */
export function emptyRegistry() {
  return { agents: {}, activity: {}, touches: {} };
}

/** The saved registry; a missing, corrupt or misshapen part reads as empty. @param {Board} board @returns {Registry} */
export function readRegistry(board) {
  const r = readJson(board.files.agents, null);
  if (!isObj(r)) return emptyRegistry();
  const reg = { ...r };
  for (const [key, empty] of Object.entries(emptyRegistry())) if (!isObj(reg[key])) reg[key] = empty;
  return /** @type {Registry} */ (reg);
}

/** The snapshot, if it can be read, has the expected shape and matches the log's size; else null. */
function currentSnapshot(board) {
  let s;
  try {
    s = readJson(board.files.state, null);
  } catch {
    return null; // unreadable (a folder in its place, permissions): rebuilt from the log like a corrupt one
  }
  const shaped = isObj(s) && s.schema === SCHEMA && Number.isSafeInteger(s.seq) && Number.isSafeInteger(s.nextId)
    && isObj(s.tasks) && Array.isArray(s.recent) && Array.isArray(s.messages);
  return shaped && s.eventsSize === fileSize(board.files.events) ? s : null;
}

/**
 * Applies one event and returns its message when the reducer accepted it (the task's messageCount
 * went up), else null. Replay and transact both use it, so the message files always agree.
 */
function applyTracked(state, ev) {
  const m = ev.type === 'message.posted' && isObj(ev.data) ? ev.data.message : null;
  const target = isObj(m) && Number.isSafeInteger(m.taskId) && Object.hasOwn(state.tasks, m.taskId) ? state.tasks[m.taskId] : null;
  const countBefore = target ? target.messageCount : 0;
  applyEvent(state, ev);
  return target && target.messageCount > countBefore ? m : null;
}

/** The log's bytes, or an empty buffer when it does not exist. Any other error is thrown. */
function readLog(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  }
}

/**
 * Replays the whole log in memory. Lines that do not parse, are not events, or repeat an earlier
 * seq are skipped and reported by their 1-based line number in the file.
 */
export function replay(board) {
  const state = emptyState();
  /** @type {number[]} */
  const bad = [];
  /** @type {Map<number, any[]>} */
  const messages = new Map();
  const bytes = readLog(board.files.events);
  bytes.toString('utf8').replace(/^﻿/, '').split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      bad.push(i + 1); // malformed, or cut off by a crash mid-write
      return;
    }
    if (!isEvent(ev) || ev.seq <= state.seq) {
      bad.push(i + 1); // parses, but is not an event (for example `null`), or repeats an earlier seq
      return;
    }
    const m = applyTracked(state, ev);
    if (m) {
      if (!messages.has(m.taskId)) messages.set(m.taskId, []);
      messages.get(m.taskId).push(m);
    }
  });
  // The size of the bytes replayed, not a second stat: an append in between must not be counted as seen.
  state.eventsSize = bytes.length;
  return { state, bad, messages };
}

/** Current state without locking; replays in memory when the snapshot is missing, corrupt or behind. */
export function readState(board) {
  return currentSnapshot(board) ?? replay(board).state;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

function rebuildUnlocked(board) {
  const { state, bad, messages } = replay(board);
  const dir = board.files.messagesDir;
  // Files are replaced one by one instead of deleting the folder, so a reader never finds a task's
  // file missing. Anything else there (tasks without messages, leftover temp files) is removed.
  const keep = new Set([...messages.keys()].map((taskId) => path.basename(messagesFile(board, taskId))));
  for (const name of listDir(dir)) {
    if (!keep.has(name)) retryWhileBusy(() => fs.rmSync(path.join(dir, name), { recursive: true, force: true }));
  }
  for (const [taskId, list] of messages) {
    writeFileAtomic(messagesFile(board, taskId), list.map((m) => JSON.stringify(m)).join('\n') + '\n');
  }
  // Written last: a current snapshot means the message files are complete.
  writeJsonAtomic(board.files.state, state, { pretty: false });
  return { state, bad };
}

/**
 * Runs fn under the board lock. When fn succeeded but the lock could not be released (another
 * process held the lock file open), the work is committed: it is logged and fn's result returned,
 * so callers do not retry a committed write; the mutex clears the orphaned lock next time (§16).
 */
function locked(board, fn, timeoutMs) {
  try {
    return withLock(board.dir, fn, { timeoutMs });
  } catch (err) {
    if (err && /** @type {any} */ (err).code === 'ELOCKRELEASE') {
      logError(board, 'lock release', /** @type {any} */ (err).cause ?? err);
      return /** @type {any} */ (err).result;
    }
    throw err;
  }
}

/** Rebuilds every snapshot from events.jsonl (`agentboard repair`). */
export function repair(board) {
  return locked(board, () => rebuildUnlocked(board));
}

function ensureNewlineAtEnd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) fs.appendFileSync(file, '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function stamp(e, seq, now) {
  const ev = { seq, at: now, type: e.type, actor: e.actor, data: e.data };
  const m = e.type === 'message.posted' && isObj(e.data) ? e.data.message : null;
  if (isObj(m)) ev.data = { ...e.data, message: { ...m, id: `m${seq}`, at: now } };
  return ev;
}

/**
 * The only write path. `fn` sees the current state and registry under the lock and returns what to write.
 * Appending the events is the commit point. Snapshot, message and registry writes that fail after it
 * are logged, not thrown, so a committed write is never reported as failed (and never repeated by a
 * retry); the stale snapshot makes the next transact rebuild the derived files from the log.
 * @template R
 * @param {Board} board
 * @param {(state: BoardState, registry: Registry, now: number) => ({ events?: any[], registry?: Registry, result?: R } | void)} fn
 * @param {{ now?: number, timeoutMs?: number }} [opts] timeoutMs bounds the wait for the lock (hooks pass a short one)
 * @returns {{ state: BoardState, events: BoardEvent[], result: R | undefined }}
 */
export function transact(board, fn, opts = {}) {
  return locked(board, () => {
    const now = opts.now ?? Date.now();
    const state = currentSnapshot(board) ?? rebuildUnlocked(board).state;
    const registry = readRegistry(board);
    const ret = fn(state, registry, now);
    if (typeof ret?.then === 'function') {
      try { ret.then(undefined, () => {}); } catch { /* a broken thenable */ } // no second crash on a later rejection
      throw new TypeError(`${NAME}: transact fn must be synchronous; it returned a promise, so nothing was written`);
    }
    const out = ret || {};
    // Round-trip through JSON so what is applied now is exactly what a replay of the log would build.
    const events = (out.events || []).map((e, i) => {
      if (!isObj(e) || typeof e.type !== 'string') {
        throw new TypeError(`${NAME}: event ${i} passed to transact has no string type; nothing was written`);
      }
      return JSON.parse(JSON.stringify(stamp(e, state.seq + 1 + i, now)));
    });
    // Applied before the append, so nothing is written if applying fails.
    const accepted = events.map((e) => applyTracked(state, e)).filter(Boolean);
    if (events.length) {
      ensureNewlineAtEnd(board.files.events); // after a crash mid-write, the cut-off line stays on its own
      fs.appendFileSync(board.files.events, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      try {
        for (const m of accepted) appendLine(messagesFile(board, m.taskId), JSON.stringify(m));
        state.eventsSize = fileSize(board.files.events);
        writeJsonAtomic(board.files.state, state, { pretty: false });
      } catch (err) {
        logError(board, 'snapshots after commit', err);
      }
    }
    if (out.registry) {
      try {
        writeJsonAtomic(board.files.agents, out.registry, { pretty: false });
      } catch (err) {
        if (!events.length) throw err; // nothing was committed: the caller sees the failure
        logError(board, 'registry after commit', err);
      }
    }
    return { state, events, result: out.result };
  }, opts.timeoutMs);
}

export function readMessages(board, taskId) {
  const out = [];
  for (const line of readLines(messagesFile(board, taskId))) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

/** Records a swallowed error (§16). Never throws. */
export function logError(board, context, err) {
  try {
    appendLine(board.files.errors, `${new Date().toISOString()} ${context}: ${(err && err.stack) || err}`);
  } catch {
    // nowhere left to report
  }
}
