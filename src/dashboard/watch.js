import fs from 'node:fs';
import path from 'node:path';
import { fileSize } from '../core/fsx.js';
import { logError } from '../core/store.js';

/**
 * @typedef {import('../core/store.js').Board} Board
 * @typedef {{ pollMs?: number, debounceMs?: number, fsWatch?: boolean }} WatchOptions
 *   pollMs: the polling fallback's period; debounceMs: the quiet time that ends a burst;
 *   fsWatch: false polls only (tests)
 */

const POLL_MS = 5_000;
const DEBOUNCE_MS = 150;

/**
 * Watches a board for changes (§13 Server), for the dashboard's live updates:
 * - fs.watch on the board folder, for the event log and the agent registry (which every hook call
 *   rewrites), or a change it cannot name;
 * - a poll every `pollMs` comparing the log's size and the registry's mtime, for file systems where
 *   fs.watch misses changes (network drives, some containers).
 * A burst of changes is one onChange call, `debounceMs` after the last one. A board folder that does
 * not exist yet is polled until it appears, then watched; a watcher that fails (its folder removed)
 * is dropped, and the poll starts a new one when it can. Never throws out of a callback: a failing
 * onChange is logged to errors.log. Until close(), the watcher and the poll keep the process alive.
 * @param {Board} board @param {() => void} onChange @param {WatchOptions} [opts]
 * @returns {{ close: () => void, readonly watching: boolean }} watching: fs.watch is running
 */
export function watchBoard(board, onChange, { pollMs = POLL_MS, debounceMs = DEBOUNCE_MS, fsWatch = true } = {}) {
  const { events, agents } = board.files;
  const names = new Set([path.basename(events), path.basename(agents)]);
  let closed = false;
  /** @type {fs.FSWatcher | null} */
  let watcher = null;
  /** @type {NodeJS.Timeout | null} */
  let pending = null;

  /** What the poll compares, or null when it cannot be read right now. */
  const mark = () => {
    try {
      return `${fileSize(events)}:${fs.statSync(agents, { throwIfNoEntry: false })?.mtimeMs ?? 0}`;
    } catch {
      return null;
    }
  };
  let last = mark();

  const fire = () => {
    pending = null;
    if (closed) return;
    last = mark() ?? last; // this change is reported: the poll must not report it again
    try {
      onChange();
    } catch (err) {
      logError(board, 'dashboard watch', err);
    }
  };

  /** A change seen: onChange runs once `debounceMs` have passed without another. */
  const changed = () => {
    if (closed) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(fire, debounceMs);
  };

  const drop = () => {
    watcher?.close();
    watcher = null;
  };

  const watch = () => {
    if (!fsWatch || watcher || closed) return;
    try {
      watcher = fs.watch(board.dir, (_type, name) => {
        if (name == null || names.has(String(name))) changed();
      });
      watcher.on('error', drop);
    } catch {
      watcher = null; // no board folder yet, or no fs.watch here: the poll goes on alone
    }
  };

  const poll = setInterval(() => {
    watch();
    const now = mark();
    if (now !== null && now !== last) {
      last = now;
      changed();
    }
  }, pollMs);
  watch();

  return {
    close() {
      closed = true;
      clearInterval(poll);
      if (pending) clearTimeout(pending);
      pending = null;
      drop();
    },
    get watching() {
      return watcher !== null;
    },
  };
}
