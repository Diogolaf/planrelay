import fs from 'node:fs';
import path from 'node:path';

/** Blocks the thread without spinning the CPU. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** @template T @param {string} file @param {T} fallback */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Writes via temp file + rename. Retries briefly on Windows when a reader holds the target open. */
export function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES'].includes(/** @type {any} */ (err).code);
      if (!retryable || attempt >= 20) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
      }
      sleepSync(10);
    }
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

/** Non-empty lines of a file, or [] when it does not exist. */
export function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((l) => l.trim() !== '');
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
