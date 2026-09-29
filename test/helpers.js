import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A fixed "now" for deterministic tests. */
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A fresh empty folder (real long path, no 8.3 short names on Windows). */
export function tempDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')));
}

/** A fresh git repository with one empty commit, so worktrees can be added. */
export function tempRepo() {
  const dir = tempDir();
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
