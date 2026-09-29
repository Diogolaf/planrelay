import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NAME } from '../name.js';

/**
 * Walks up from `start` to the nearest `.git`. A `.git` file (worktree or submodule) points to its git dir,
 * whose `commondir` file points to the shared one.
 * @returns {{ top: string, gitDir: string, commonDir: string } | null}
 */
function findGit(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return { top: dir, gitDir: dotGit, commonDir: dotGit };
    if (stat?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (m) {
        const gitDir = path.resolve(dir, m[1]);
        let commonDir = gitDir;
        try {
          commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        } catch {
          // not a linked worktree (for example a submodule): its own git dir is shared
        }
        return { top: dir, gitDir, commonDir };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where the board for a folder lives (§6).
 * @param {string} cwd
 * @param {{ home?: string }} [opts]
 * @returns {{ boardDir: string, repoRoot: string, projectName: string, inGit: boolean, gitDir: string | null }}
 */
export function resolveBoard(cwd, opts = {}) {
  const home = opts.home ?? os.homedir();
  const git = findGit(cwd);
  if (git) {
    const mainRoot = path.basename(git.commonDir) === '.git' ? path.dirname(git.commonDir) : git.top;
    return {
      boardDir: path.join(git.commonDir, NAME), repoRoot: git.top, projectName: path.basename(mainRoot), inGit: true, gitDir: git.gitDir,
    };
  }
  const abs = path.resolve(cwd);
  const hash = createHash('sha256').update(abs).digest('hex');
  return {
    boardDir: path.join(home, `.${NAME}`, 'boards', hash), repoRoot: abs, projectName: path.basename(abs), inGit: false, gitDir: null,
  };
}

/** The checked-out branch, read from HEAD without spawning git; a short commit id when detached. */
export function currentBranch(gitDir) {
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 12);
  } catch {
    return null;
  }
}

/** Path equality that ignores case on Windows. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Repo-relative path with forward slashes, used as the key for file touches and locks. */
export function toRepoPath(repoRoot, file) {
  return path.relative(repoRoot, path.resolve(repoRoot, file)).split(path.sep).join('/');
}
