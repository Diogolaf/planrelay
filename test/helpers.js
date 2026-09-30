import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** A fixed "now" for deterministic tests. */
export const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

const created = [];

/** Removes every folder tempDir made; runs once when the test process exits and never throws. */
function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // a folder that cannot be removed now is left for the OS temp cleanup
    }
  }
}
process.on('exit', cleanup);

/** A fresh empty folder (real long path, no 8.3 short names on Windows), removed when the process exits. */
export function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'planrelay-test-')));
  created.push(dir);
  return dir;
}

let emptyGitConfig;

/**
 * Environment for running git in test repositories: no GIT_* variables inherited from a calling
 * git hook, and an empty global config and no system config, so personal settings (signing,
 * hooksPath, templates) cannot break tests.
 */
export function gitEnv() {
  emptyGitConfig ??= path.join(tempDir(), 'gitconfig');
  fs.writeFileSync(emptyGitConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  return { ...env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1' };
}

/** A fresh git repository with one empty commit, so worktrees can be added. */
export function tempRepo() {
  const dir = tempDir();
  const env = gitEnv();
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}
