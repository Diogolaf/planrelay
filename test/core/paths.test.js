import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBoard, samePath, toRepoPath, currentBranch } from '../../src/core/paths.js';
import { gitEnv, tempDir, tempRepo } from '../helpers.js';

test('currentBranch reads HEAD', () => {
  const repo = tempRepo();
  execFileSync('git', ['checkout', '-q', '-b', 'feature/filters'], { cwd: repo, stdio: 'ignore', env: gitEnv() });
  assert.equal(currentBranch(resolveBoard(repo).gitDir), 'feature/filters');
  assert.equal(currentBranch(null), null);
});

test('inside a repository the board lives in the git directory', () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, 'src'));
  for (const cwd of [repo, path.join(repo, 'src')]) {
    const b = resolveBoard(cwd);
    assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
    assert.ok(samePath(b.repoRoot, repo));
    assert.equal(b.projectName, path.basename(repo));
    assert.equal(b.inGit, true);
  }
});

test('every worktree shares the main repository board', () => {
  const repo = tempRepo();
  const wt = path.join(tempDir(), 'feature-x');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo, stdio: 'ignore', env: gitEnv() });
  const b = resolveBoard(wt);
  assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
  assert.ok(samePath(b.repoRoot, wt));
  assert.equal(b.projectName, path.basename(repo));
});

test('outside git the board lives under the home folder, keyed by path hash', () => {
  const dir = tempDir();
  const home = tempDir();
  const b = resolveBoard(dir, { home });
  assert.equal(b.inGit, false);
  assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')));
  assert.match(path.basename(b.boardDir), /^[0-9a-f]{64}$/);
});

test('toRepoPath gives forward-slash repo-relative paths', () => {
  const root = tempDir();
  assert.equal(toRepoPath(root, path.join(root, 'src', 'a.js')), 'src/a.js');
  assert.equal(toRepoPath(root, 'src/b.js'), 'src/b.js');
});
