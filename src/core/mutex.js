import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NAME } from '../name.js';
import { BUSY_RETRY_MS, ensureDir, isBusyError, retryWhileBusy, sleepSync } from './fsx.js';

/** A lock this old whose process is dead is taken over. */
const STALE_MS = 10_000;
/** A lock this old is taken over even when its pid is alive (pid reuse, a hung holder). */
const HARD_STALE_MS = 120_000;
/** A lock time further ahead than this is not believed (the clock was stepped back). */
const FUTURE_SLACK_MS = 10_000;
/** A takeover guard this old was left by a crashed process and is removed. */
const GUARD_STALE_MS = 10_000;
/** Windows "access denied" on create that lasts with no lock file in sight is a real error. */
const DENIED_CODES = new Set(['EPERM', 'EACCES']);

/** Lock folders held by this thread, to refuse a nested withLock that would wait on itself. */
const held = new Set();
/** Folder → token of a lock this thread failed to release; deleted on the next withLock there. */
const orphans = new Map();

/**
 * The file operations withLock uses; tests replace them to simulate failures.
 * @typedef {{ create(file: string, body: string): void, unlink(file: string): void }} LockIo
 * @type {LockIo}
 */
const fsIo = {
  /** Creates the file with the given content; throws EEXIST when it already exists. */
  create(file, body) {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeSync(fd, body);
    } catch (err) {
      fs.closeSync(fd);
      try { fs.unlinkSync(file); } catch { /* the stale check will clear it */ }
      throw err;
    }
    fs.closeSync(fd);
  },
  unlink: (file) => fs.unlinkSync(file),
};

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err).code === 'EPERM';
  }
}

/**
 * Tries to create the file. False when it exists, or (Windows) when its name is still held by
 * a deleted file that another process has open; `state.lastErr` keeps that error.
 */
function tryCreate(io, file, body, state) {
  try {
    io.create(file, body);
    return true;
  } catch (err) {
    const code = /** @type {any} */ (err).code;
    if (code === 'EEXIST') {
      state.lastErr = null;
      return false;
    }
    if (isBusyError(err)) {
      state.lastErr = err;
      return false;
    }
    throw err;
  }
}

/**
 * What the lock file looks like right now, or null when it is gone or cannot be read.
 * `raw` + inode + mtime identify one particular lock file.
 */
function snapshot(file) {
  try {
    const st = fs.statSync(file, { bigint: true });
    const raw = fs.readFileSync(file, 'utf8');
    let info = null;
    try {
      info = JSON.parse(raw);
    } catch {
      // being written right now, or corrupt: judged by its mtime
    }
    return { ino: st.ino, mtimeNs: st.mtimeNs, mtimeMs: Number(st.mtimeMs), raw, info };
  } catch {
    return null;
  }
}

function sameLock(a, b) {
  return !!a && !!b && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.raw === b.raw;
}

/**
 * How long ago the lock was taken: from its own `at` if believable, else from the file's mtime,
 * or null when both lie in the future (the clock was stepped back since).
 */
function lockAge(s, now) {
  const at = s.info?.at;
  if (Number.isFinite(at) && at <= now + FUTURE_SLACK_MS) return now - at;
  if (s.mtimeMs <= now + FUTURE_SLACK_MS) return now - s.mtimeMs;
  return null;
}

function isStale(s, now) {
  if (!s) return false;
  const age = lockAge(s, now);
  if (age === null) return !pidAlive(s.info?.pid); // age unknown: only a dead holder is judged
  if (age > HARD_STALE_MS) return true;
  return age > STALE_MS && !pidAlive(s.info?.pid);
}

/**
 * Deletes the stale lock `seen`, but only while holding `<lock>.break` and only if the lock is
 * still that exact file: another waiter may already have replaced it with a live lock.
 * @returns {boolean} true when the stale lock was deleted
 */
function breakStale(io, file, seen) {
  const guard = `${file}.break`;
  if (!tryCreate(io, guard, String(process.pid), {})) {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) io.unlink(guard);
    } catch {
      // released or removed meanwhile
    }
    return false;
  }
  try {
    const cur = snapshot(file);
    if (!sameLock(cur, seen) || !isStale(cur, Date.now())) return false;
    io.unlink(file);
    return true;
  } catch {
    return false; // could not delete it; wait and retry
  } finally {
    try { retryWhileBusy(() => io.unlink(guard)); } catch { /* expires after GUARD_STALE_MS */ }
  }
}

/** Deletes the lock if it still carries our token (it may have been taken over as stale). */
function release(io, file, token) {
  retryWhileBusy(() => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (/** @type {any} */ (err).code === 'ENOENT') return;
      throw err;
    }
    let info = null;
    try {
      info = JSON.parse(raw);
    } catch {
      return; // not a lock we wrote
    }
    if (info?.token !== token) return;
    try {
      io.unlink(file);
    } catch (err) {
      if (/** @type {any} */ (err).code !== 'ENOENT') throw err;
    }
  });
}

function heldKey(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Runs fn while holding `<dir>/lock`, shared by every process on this machine.
 * A lock older than 10 s whose process is dead, or older than 120 s whatever its process, is
 * taken over. fn must be synchronous: the lock is released as soon as it returns, so async work
 * would run unlocked; a returned promise is rejected with a TypeError. Calling withLock on the
 * same folder from inside fn throws.
 * If fn succeeded but the lock could not be released, the error has code 'ELOCKRELEASE', fn's
 * return value in `result` and the unlink error in `cause`: the work is done, and the next
 * withLock on that folder in this thread retries deleting the lock.
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, io?: Partial<LockIo> }} [opts] `io` is a test seam
 * @returns {T}
 */
export function withLock(dir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const io = { ...fsIo, ...opts.io };
  ensureDir(dir);
  const key = heldKey(dir);
  if (held.has(key)) throw new Error(`${NAME}: withLock is not re-entrant; ${dir} is already locked by this thread`);
  const file = path.join(dir, 'lock');
  if (orphans.has(key)) {
    try {
      release(io, file, orphans.get(key));
      orphans.delete(key);
    } catch {
      // still stuck: wait for it like any other lock, and try again next time
    }
  }
  const token = randomUUID();
  const state = { lastErr: null };
  const start = performance.now();
  let deniedSince = null;
  while (!tryCreate(io, file, JSON.stringify({ pid: process.pid, at: Date.now(), token }), state)) {
    const s = snapshot(file);
    if (isStale(s, Date.now()) && breakStale(io, file, s)) continue;
    const elapsed = performance.now() - start;
    if (!s && state.lastErr && DENIED_CODES.has(state.lastErr.code)) {
      deniedSince ??= elapsed;
      if (elapsed - deniedSince > BUSY_RETRY_MS) throw state.lastErr; // not a lock being deleted
    } else {
      deniedSince = null;
    }
    if (elapsed > timeoutMs) {
      if (!s && state.lastErr) throw state.lastErr;
      const holder = s?.info?.pid ?? 'unknown';
      throw new Error(`${NAME}: the board is locked by another process (lock ${file}, held by pid ${holder})`);
    }
    sleepSync(10 + Math.random() * 10);
  }
  held.add(key);
  let result;
  try {
    result = fn();
  } catch (err) {
    try {
      release(io, file, token);
    } catch (releaseErr) {
      orphans.set(key, token);
      throw new AggregateError([err, releaseErr], `${NAME}: the locked operation failed and the lock ${file} could not be released`);
    } finally {
      held.delete(key);
    }
    throw err;
  }
  try {
    release(io, file, token);
  } catch (releaseErr) {
    orphans.set(key, token);
    const err = new Error(`${NAME}: the locked operation completed, but the lock ${file} could not be released`, { cause: releaseErr });
    throw Object.assign(err, { code: 'ELOCKRELEASE', result });
  } finally {
    held.delete(key);
  }
  if (typeof result?.then === 'function') {
    try { result.then(undefined, () => {}); } catch { /* a broken thenable */ } // no second crash on a later rejection
    throw new TypeError(`${NAME}: withLock fn must be synchronous; it returned a promise, so its work ran unlocked`);
  }
  return result;
}
