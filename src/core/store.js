import fs from 'node:fs';
import path from 'node:path';
import { NAME } from '../name.js';
import { readConfig } from './config.js';
import {
  appendLine, fileSize, isBusyError, readJson, readLines, retryWhileBusy, writeFileAtomic, writeJsonAtomic,
} from './fsx.js';
import { withLock } from './mutex.js';
import { resolveBoard } from './paths.js';
import { applyEvent, emptyState, isEvent, SCHEMA } from './reduce.js';

/** @typedef {import('./reduce.js').BoardState} BoardState */
/** @typedef {import('./reduce.js').BoardEvent} BoardEvent */
/**
 * Housekeeping (maintenance.js) adds `missing`, when a claim's folder was first seen missing, by
 * task id, and `sweptAt`, the time of the last file-system sweep.
 * @typedef {{
 *   agents: Record<string, any>,
 *   activity: Record<number, number>,
 *   touches: Record<string, { agent: string, task: number | null, at: number }>,
 *   missing?: Record<string, { agent: string, folder: string, at: number }>,
 *   sweptAt?: number
 * }} Registry
 */

const NEWLINE = 0x0a;
/** Tries before giving up on a log that keeps growing under the lock (another writer holds it too). */
const FENCE_ATTEMPTS = 3;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlainObj = (v) => isObj(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isId = (v) => Number.isSafeInteger(v) && v >= 1;

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

/** The message file of a task; throws unless taskId is a whole number of 1 or more. */
export function messagesFile(board, taskId) {
  if (!isId(taskId)) throw new TypeError(`${NAME}: a task id is a whole number of 1 or more, not ${String(taskId)}`);
  return path.join(board.files.messagesDir, `${taskId}.jsonl`);
}

/** @returns {Registry} */
export function emptyRegistry() {
  return { agents: {}, activity: {}, touches: {} };
}

/** Which entries of each registry part are kept; anything else is dropped on read. */
const REGISTRY_ENTRY = {
  agents: (key, v) => key !== '' && isPlainObj(v),
  activity: (key, v) => Number.isFinite(v),
  touches: (key, v) => isPlainObj(v),
};

/**
 * The saved registry. A missing, corrupt or misshapen part reads as empty, and malformed entries
 * are dropped (an agent or touch that is not an object, an activity time that is not a number, an
 * agent with an empty id), so one bad entry can never make every write throw. Other top-level
 * keys are kept. @param {Board} board @returns {Registry}
 */
export function readRegistry(board) {
  const r = readJson(board.files.agents, null);
  if (!isObj(r)) return emptyRegistry();
  const reg = { ...r };
  for (const [part, keep] of Object.entries(REGISTRY_ENTRY)) {
    // fromEntries defines own properties, so a "__proto__" key can never replace the prototype.
    reg[part] = isObj(r[part]) ? Object.fromEntries(Object.entries(r[part]).filter(([k, v]) => keep(k, v))) : {};
  }
  return /** @type {Registry} */ (reg);
}

/** The snapshot when it can be read and has the expected shape, else null. Its size is not compared with the log. */
function readSnapshot(board) {
  let s;
  try {
    s = readJson(board.files.state, null);
  } catch {
    return null; // unreadable (a folder in its place, permissions): replayed like a corrupt one
  }
  const ok = isObj(s) && s.schema === SCHEMA && Number.isSafeInteger(s.seq) && Number.isSafeInteger(s.nextId)
    && Number.isSafeInteger(s.eventsSize) && s.eventsSize >= 0
    && isObj(s.tasks) && Array.isArray(s.recent) && Array.isArray(s.messages);
  return ok ? /** @type {BoardState} */ (s) : null;
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

/** The batch an event belongs to; an event without `tx` and `n` is a batch of its own. Null when malformed. */
function frameOf(ev) {
  if (ev.tx === undefined && ev.n === undefined) return { tx: ev.seq, n: 1 };
  const { tx, n } = ev;
  const ok = Number.isSafeInteger(tx) && Number.isSafeInteger(n) && tx >= 1 && n >= 1 && ev.seq >= tx && ev.seq - tx < n;
  return ok ? { tx, n } : null;
}

/**
 * Applies the lines of `buf` to `state`, one complete batch at a time.
 * - A line counts once its newline is written: bytes after the last newline are left alone (a
 *   write in progress, or cut off by a crash; the next writer terminates such a line before appending).
 * - Lines that do not parse, are not events, repeat an earlier seq, or belong to a batch whose `n`
 *   events are not all present on consecutive lines are skipped and reported.
 * @param {BoardState} state
 * @param {Buffer} buf
 * @param {{ atFileStart?: boolean, onMessage?: ((m: any) => void) | null }} [opts]
 * @returns {{ end: number, bad: number[], orphan: boolean }} end: bytes consumed; bad: 1-based line
 *   numbers within buf; orphan: some batch continues without its first event (it began before buf)
 */
function applyLines(state, buf, { atFileStart = false, onMessage = null } = {}) {
  const end = buf.lastIndexOf(NEWLINE) + 1;
  const bom = atFileStart && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  /** @type {number[]} */
  const bad = [];
  let orphan = false;
  /** @type {{ tx: number, n: number, events: any[], lines: number[], repeated: boolean } | null} */
  let batch = null;
  const close = () => {
    if (batch.repeated) bad.push(...batch.lines);
    else {
      for (const ev of batch.events) {
        const m = applyTracked(state, ev);
        if (m && onMessage) onMessage(m);
      }
    }
    batch = null;
  };
  const lines = end > bom ? buf.toString('utf8', bom, end).split('\n') : [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      ev = undefined; // malformed, or cut off by a crash mid-write
    }
    const frame = isEvent(ev) ? frameOf(ev) : null;
    if (batch) {
      if (frame && frame.tx === batch.tx && frame.n === batch.n && ev.seq === batch.tx + batch.events.length) {
        batch.events.push(ev);
        batch.lines.push(i + 1);
        if (batch.events.length === batch.n) close();
        return;
      }
      bad.push(...batch.lines); // cut short: the rest of the batch never arrived
      batch = null;
    }
    if (!frame) {
      bad.push(i + 1); // not an event (for example `null`), or a malformed batch marker
    } else if (ev.seq !== frame.tx) {
      bad.push(i + 1); // a batch continued without its first event
      orphan = true;
    } else {
      // A repeated seq condemns the whole batch; its lines are still read, so they do not look orphaned.
      batch = { tx: frame.tx, n: frame.n, events: [ev], lines: [i + 1], repeated: ev.seq <= state.seq };
      if (batch.n === 1) close();
    }
  });
  if (batch) bad.push(...batch.lines); // incomplete at the end: a write cut short, or still being written
  return { end, bad, orphan };
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
 * Replays the whole log in memory. Skipped lines are reported by their 1-based line number in the
 * file. `messages: false` skips collecting the per-task messages (readers only need the state).
 * @param {Board} board @param {{ messages?: boolean }} [opts]
 */
export function replay(board, opts = {}) {
  const state = emptyState();
  /** @type {Map<number, any[]>} */
  const messages = new Map();
  const onMessage = opts.messages === false ? null : (m) => {
    if (!messages.has(m.taskId)) messages.set(m.taskId, []);
    messages.get(m.taskId).push(m);
  };
  const { end, bad } = applyLines(state, readLog(board.files.events), { atFileStart: true, onMessage });
  state.eventsSize = end; // the bytes replayed, never a second size check
  return { state, bad, messages };
}

/**
 * The snapshot brought up to date by applying only the log's tail, or null when that cannot be
 * trusted: the log shrank, the snapshot's size is not a line boundary, or a batch straddles it.
 * @param {Board} board @param {BoardState} s
 */
function catchUp(board, s) {
  let fd;
  try {
    fd = fs.openSync(board.files.events, 'r');
  } catch {
    return s.eventsSize === 0 ? s : null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === s.eventsSize) return s;
    if (size < s.eventsSize) return null;
    // One byte before the tail too: it must be the newline that ends the snapshot's last line.
    const from = s.eventsSize === 0 ? 0 : s.eventsSize - 1;
    const buf = Buffer.alloc(size - from);
    for (let got = 0; got < buf.length;) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (n === 0) return null; // shrank meanwhile
      got += n;
    }
    if (s.eventsSize > 0 && buf[0] !== NEWLINE) return null;
    const { end, orphan } = applyLines(s, s.eventsSize > 0 ? buf.subarray(1) : buf, { atFileStart: s.eventsSize === 0 });
    if (orphan) return null;
    s.eventsSize += end;
    return s;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Current state without locking. A usable snapshot is caught up with the log's tail in memory;
 * the whole log is replayed only when the snapshot is missing, corrupt or cannot be caught up.
 * The next write saves the result under the lock.
 */
export function readState(board) {
  const s = readSnapshot(board);
  let caught = null;
  if (s) {
    try {
      caught = catchUp(board, s);
    } catch {
      caught = null;
    }
  }
  return caught ?? replay(board, { messages: false }).state;
}

function listDir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

const removeQuietly = (file) => retryWhileBusy(() => fs.rmSync(file, { recursive: true, force: true }));

/**
 * Replays the log and rewrites every derived file from it: message files first, the snapshot last
 * and only when all of them were written, since a current snapshot vouches for them.
 * Strict (repair) throws at the first failure. Otherwise (inside transact) each failure is logged
 * and reported in `degraded`, and the write goes on: a derived file that cannot be written never
 * makes the board read-only, and the stale snapshot makes the next write try again. After a
 * Windows busy error, which has already waited out its retries, the rest of that kind is skipped.
 * @param {Board} board @param {boolean} strict
 */
function rebuild(board, strict) {
  const { state, bad, messages } = replay(board);
  /** @type {Set<string>} */
  const degraded = new Set();
  /** Kinds given up on: a Windows busy error has already waited out its retries (about 2 s) once. */
  const given = new Set();
  const attempt = (kind, what, f) => {
    if (given.has(kind)) return;
    try {
      f();
    } catch (err) {
      if (strict) throw err;
      logError(board, `rebuild ${what}`, err);
      degraded.add(kind);
      if (isBusyError(err)) given.add(kind); // the other files would likely wait as long: keep the write fast
    }
  };
  const dir = board.files.messagesDir;
  // Files are replaced one by one instead of deleting the folder, so a reader never finds a task's
  // file missing. Anything else there (tasks without messages, leftover temp files) is removed.
  const keep = new Set([...messages.keys()].map((taskId) => `${taskId}.jsonl`));
  /** @type {string[]} */
  let names = [];
  attempt('messages', 'state/messages', () => { names = listDir(dir); });
  for (const name of names) {
    if (!keep.has(name)) attempt('messages', `state/messages/${name}`, () => removeQuietly(path.join(dir, name)));
  }
  for (const [taskId, list] of messages) {
    attempt('messages', `state/messages/${taskId}.jsonl`, () =>
      writeFileAtomic(messagesFile(board, taskId), list.map((m) => JSON.stringify(m)).join('\n') + '\n'));
  }
  if (degraded.size) degraded.add('snapshot'); // not written: it would vouch for incomplete message files
  else attempt('snapshot', 'state/board.json', () => writeJsonAtomic(board.files.state, state, { pretty: false }));
  return { state, bad, degraded: [...degraded] };
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

/** Removes temp files left by writers that crashed between writing and renaming (the lock is held). */
function removeTempFiles(board) {
  for (const dir of [board.dir, path.dirname(board.files.state)]) {
    for (const entry of listDir(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.tmp')) removeQuietly(path.join(dir, entry.name));
    }
  }
}

/**
 * Rebuilds every snapshot from events.jsonl (`agentboard repair`). Strict: a derived file that
 * cannot be written is an error. Returns the rebuilt state and the skipped lines.
 */
export function repair(board) {
  return locked(board, () => {
    ensureNewlineAtEnd(board.files.events);
    removeTempFiles(board);
    const { state, bad } = rebuild(board, true);
    return { state, bad };
  });
}

/** Ends the file with a newline if it does not, so a line cut off by a crash stays on its own. */
function ensureNewlineAtEnd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return; // missing (nothing to end), or unusable (the append that follows reports it)
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== NEWLINE) fs.appendFileSync(file, '\n');
  } finally {
    fs.closeSync(fd);
  }
}

function stamp(e, seq, tx, n, now) {
  const ev = { seq, tx, n, at: now, type: e.type, actor: e.actor, data: e.data };
  const m = e.type === 'message.posted' && isObj(e.data) ? e.data.message : null;
  if (isObj(m)) ev.data = { ...e.data, message: { ...m, id: `m${seq}`, at: now } };
  return ev;
}

/** The value a synchronous callback returned; a promise is refused (its work would run unlocked). */
function synchronous(ret, who) {
  if (typeof ret?.then === 'function') {
    try { ret.then(undefined, () => {}); } catch { /* a broken thenable */ } // no second crash on a later rejection
    throw new TypeError(`${NAME}: transact ${who} must be synchronous; it returned a promise, so nothing was written`);
  }
  return ret;
}

/**
 * Runs `before` (housekeeping) and then fn on the state and a fresh registry, and checks, stamps and
 * applies what they return, all as one batch: before's events come first and are applied before fn
 * runs, so fn sees their effects. Writes nothing; a throw here commits nothing.
 * @returns {{ out: any, events: BoardEvent[], accepted: any[] }} accepted: the messages the reducer took
 */
function prepare(board, state, fn, before, now) {
  const registry = readRegistry(board);
  const tx = state.seq + 1;
  /** @type {BoardEvent[]} */
  const events = [];
  const accepted = [];
  const add = (list, who) => {
    if (!Array.isArray(list)) throw new TypeError(`${NAME}: transact ${who} events must be an array; nothing was written`);
    list.forEach((e, i) => {
      if (!isObj(e) || typeof e.type !== 'string') {
        throw new TypeError(`${NAME}: event ${i} returned by transact ${who} has no string type; nothing was written`);
      }
      // Round-trip through JSON so what is applied now is exactly what a replay of the log would build.
      // n is provisional: it is set on every event once the batch is complete.
      const ev = JSON.parse(JSON.stringify(stamp(e, tx + events.length, tx, 0, now)));
      if (!isEvent(ev)) throw new TypeError(`${NAME}: event ${i} returned by transact ${who} is not a valid event; nothing was written`);
      events.push(ev);
      const m = applyTracked(state, ev);
      if (m) accepted.push(m);
    });
  };
  if (before) add(synchronous(before(state, registry, now), 'before') ?? [], 'before');
  const out = synchronous(fn(state, registry, now), 'fn') ?? {};
  if (!isObj(out)) throw new TypeError(`${NAME}: transact fn must return an object or nothing; nothing was written`);
  if (out.registry != null && !isPlainObj(out.registry)) {
    throw new TypeError(`${NAME}: the registry returned to transact must be a plain object; nothing was written`);
  }
  add(out.events ?? [], 'fn');
  for (const ev of events) ev.n = events.length;
  return { out, events, accepted };
}

/** The current snapshot, or a lenient rebuild when it is missing, corrupt or behind the log. */
function openState(board) {
  const snap = readSnapshot(board);
  if (snap && snap.eventsSize === fileSize(board.files.events)) return { state: snap, degraded: [] };
  const { state, degraded } = rebuild(board, false);
  return { state, degraded };
}

/** Appends the whole batch or nothing: a failed append is truncated back to `sizeBefore`. */
function appendEvents(board, payload, sizeBefore) {
  const file = board.files.events;
  try {
    fs.appendFileSync(file, payload);
  } catch (err) {
    try {
      if (fileSize(file) !== sizeBefore) retryWhileBusy(() => fs.truncateSync(file, sizeBefore));
    } catch (truncateErr) {
      logError(board, 'truncating the log after a failed append', truncateErr); // replay ignores the incomplete batch
    }
    throw err;
  }
}

function appendMessage(board, m) {
  const file = messagesFile(board, m.taskId);
  ensureNewlineAtEnd(file);
  appendLine(file, JSON.stringify(m));
}

/**
 * The only write path. `fn` sees the current state and registry under the lock and returns what to
 * write; it may run again (with a fresh registry) if the log changed under the lock, so it must not
 * have other side effects that matter.
 *
 * `opts.before(state, registry, now)`, when given, is housekeeping (§10): it runs first, under the
 * same lock, and returns an array of events (it may also change the registry). They are stamped
 * and applied before fn runs, so fn sees their effects, and they are written in the same batch,
 * ahead of fn's events; if fn throws, none of them is written. It runs again with fn on a fence
 * re-run. Like fn's own changes, its registry changes are saved only when fn returns the registry.
 *
 * Order of a write (§6): agent registry, event append (the commit point: the whole batch or
 * nothing), message files, snapshot. A failure before the append throws and commits nothing (a
 * registry already written is harmless). A derived file that cannot be written, after the append
 * or in the rebuild a stale snapshot needs first, is logged and reported in `degraded`
 * ('messages', 'snapshot'), never thrown, so a committed write is not repeated; the stale snapshot
 * makes the next write rebuild the derived files.
 * @template R
 * @param {Board} board
 * @param {(state: BoardState, registry: Registry, now: number) => ({ events?: any[], registry?: Registry, result?: R } | void)} fn
 * @param {{
 *   now?: number, timeoutMs?: number,
 *   before?: (state: BoardState, registry: Registry, now: number) => any[] | void
 * }} [opts] timeoutMs bounds the wait for the lock (hooks pass a short one)
 * @returns {{ state: BoardState, events: BoardEvent[], result: R | undefined, degraded: string[] }}
 */
export function transact(board, fn, opts = {}) {
  const before = opts.before ?? null;
  if (before !== null && typeof before !== 'function') throw new TypeError(`${NAME}: transact before must be a function`);
  return locked(board, () => {
    const now = opts.now ?? Date.now();
    const file = board.files.events;
    ensureNewlineAtEnd(file);
    let { state, degraded } = openState(board);
    let { out, events, accepted } = prepare(board, state, fn, before, now);
    // Fence: never append on top of events this state has not seen. The log can grow under the lock
    // only when the lock was taken over as stale while still held; then rebuild and run before and
    // fn again. (prepare applied the events to `state` already; that leaves eventsSize alone.)
    for (let attempt = 1; events.length && fileSize(file) !== state.eventsSize; attempt++) {
      const found = fileSize(file);
      if (attempt >= FENCE_ATTEMPTS) {
        throw new Error(`${NAME}: the event log keeps changing while this process holds the lock (${file}); nothing was written`);
      }
      logError(board, 'fence', new Error(`the event log changed under the lock (${state.eventsSize} bytes seen, ${found} found); rebuilding`));
      ensureNewlineAtEnd(file);
      ({ state, degraded } = rebuild(board, false));
      ({ out, events, accepted } = prepare(board, state, fn, before, now));
    }
    if (out.registry != null) writeJsonAtomic(board.files.agents, out.registry, { pretty: false });
    if (events.length) {
      const sizeBefore = state.eventsSize;
      if (fileSize(file) !== sizeBefore) {
        throw new Error(`${NAME}: the event log changed while this process held the lock (${file}); nothing was appended`);
      }
      const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      appendEvents(board, payload, sizeBefore); // the commit point
      state.eventsSize = sizeBefore + Buffer.byteLength(payload);
      const failed = new Set(degraded);
      for (const m of accepted) {
        try {
          appendMessage(board, m);
        } catch (err) {
          logError(board, `messages/${m.taskId}.jsonl after commit`, err);
          failed.add('messages');
        }
      }
      // A failed rebuild left the derived files behind, and failed appends left a message file
      // incomplete: the snapshot is not written, so the next write rebuilds.
      if (failed.size) failed.add('snapshot');
      else {
        try {
          writeJsonAtomic(board.files.state, state, { pretty: false });
        } catch (err) {
          logError(board, 'snapshot after commit', err);
          failed.add('snapshot');
        }
      }
      degraded = [...failed];
    }
    return { state, events, result: out.result, degraded };
  }, opts.timeoutMs);
}

/** Every message of a task, oldest first; [] for an id that is not a whole number of 1 or more. */
export function readMessages(board, taskId) {
  if (!isId(taskId)) return [];
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
