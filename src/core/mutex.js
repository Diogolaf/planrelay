import fs from 'node:fs';
import path from 'node:path';
import { NAME } from '../name.js';
import { ensureDir, sleepSync } from './fsx.js';

const STALE_MS = 10_000;

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err).code === 'EPERM';
  }
}

function tryAcquire(file) {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (/** @type {any} */ (err).code === 'EEXIST') return false;
    throw err;
  }
}

function isStale(file, now) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false; // released meanwhile; just retry
  }
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // being written right now, or corrupt
  }
  if (info) return now - info.at > STALE_MS && !pidAlive(info.pid);
  return now - stat.mtimeMs > STALE_MS;
}

/**
 * Runs fn while holding `<dir>/lock`. A lock older than 10 s whose process is dead is taken over.
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {T}
 */
export function withLock(dir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  ensureDir(dir);
  const file = path.join(dir, 'lock');
  const start = Date.now();
  while (!tryAcquire(file)) {
    const now = Date.now();
    if (isStale(file, now)) {
      try { fs.unlinkSync(file); } catch { /* someone else took it over */ }
      continue;
    }
    if (now - start > timeoutMs) throw new Error(`${NAME}: the board is locked by another process`);
    sleepSync(15);
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(file); } catch { /* already removed */ }
  }
}
