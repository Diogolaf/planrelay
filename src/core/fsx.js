import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Total time the Windows retries below may wait before giving up. */
const BUSY_RETRY_MS = 2_000;

/** Blocks the thread without spinning the CPU. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True for the errors Windows reports while another process holds a file open or a deleted file
 * is still pending removal. They clear up by themselves; on POSIX the same codes are permanent.
 */
export function isBusyError(err) {
  return IS_WIN && BUSY_CODES.has(/** @type {any} */ (err)?.code);
}

/**
 * Runs fn, retrying with exponential backoff (about 2 s in total) while it fails with a Windows
 * busy error. Any other error, or a busy error that outlasts the budget, is thrown.
 * @template T @param {() => T} fn @returns {T}
 */
export function retryWhileBusy(fn) {
  for (let waited = 0, delay = 5; ; delay = Math.min(delay * 2, 250)) {
    try {
      return fn();
    } catch (err) {
      if (!isBusyError(err) || waited >= BUSY_RETRY_MS) throw err;
      sleepSync(delay);
      waited += delay;
    }
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Parsed JSON, or the fallback when the file does not exist or is not valid JSON.
 * Any other error (permissions, a folder at that path, ...) is thrown.
 * @template T @param {string} file @param {T} fallback
 */
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return fallback;
    throw err;
  }
}

/**
 * Writes via temp file + rename, so readers see the old or the new content, never a mix.
 * On Windows the rename is retried for about 2 s while a reader holds the target open;
 * on POSIX a failed rename is thrown at once.
 */
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    retryWhileBusy(() => fs.renameSync(tmp, file));
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

/** @param {string} file @param {unknown} value @param {{ pretty?: boolean }} [opts] */
export function writeJsonAtomic(file, value, opts = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, opts.pretty === false ? 0 : 2) + '\n');
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line + '\n');
}

/** Non-empty lines of a file, or [] when it does not exist. Any other error is thrown. */
export function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter((l) => l.trim() !== '');
}

/** Size in bytes, or 0 when the file does not exist. Any other error is thrown. */
export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return 0;
    throw err;
  }
}
