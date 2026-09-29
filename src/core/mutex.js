import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NAME } from '../name.js';
import { ensureDir, isBusyError, retryWhileBusy, sleepSync } from './fsx.js';

/** A lock this old whose process is dead is taken over. */
const STALE_MS = 10_000;
/** A lock this old is taken over even when its pid is alive (pid reuse, a hung holder). */
const HARD_STALE_MS = 120_000;
/** A lock claiming a time further ahead than this is judged by its mtime instead. */
const FUTURE_SLACK_MS = 10_000;
/** A takeover guard this old was left by a crashed process and is removed. */
const GUARD_STALE_MS = 10_000;

/** Lock folders held by this thread, to refuse a nested withLock that would wait on itself. */
const held = new Set();

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

/** When the lock was taken: its own `at` if believable, else the file's mtime. */
function takenAt(s, now) {
  const at = s.info?.at;
  return Number.isFinite(at) && at <= now + FUTURE_SLACK_MS ? at : s.mtimeMs;
}

function isStale(s, now) {
  if (!s) return false;
  const age = now - takenAt(s, now);
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
 * would run unlocked. Calling withLock on the same folder from inside fn throws.
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
  const token = randomUUID();
  const state = { lastErr: null };
  const start = performance.now();
  while (!tryCreate(io, file, JSON.stringify({ pid: process.pid, at: Date.now(), token }), state)) {
    const s = snapshot(file);
    if (isStale(s, Date.now()) && breakStale(io, file, s)) continue;
    if (performance.now() - start > timeoutMs) {
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
      throw new AggregateError([err, releaseErr], `${NAME}: the locked operation failed and the lock ${file} could not be released`);
    } finally {
      held.delete(key);
    }
    throw err;
  }
  try {
    release(io, file, token);
  } finally {
    held.delete(key);
  }
  return result;
}
