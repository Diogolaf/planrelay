// Integration tests: run the leak guard CLI as a child process inside throwaway git
// repositories. Every term, name and e-mail here is invented.
// Children never see the maintainer's setup: HOME/USERPROFILE point at the temp folder,
// inherited GIT_* and AGENTBOARD_* variables are dropped, and git ignores system and
// global config. So a test can never read the private list or touch this repository.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-denylist.mjs', import.meta.url));
const TERMS = ['zorbacorp', 'quux-project', 'Élodie']; // entries #1, #2, #3
const LIST = `# invented test terms\n${TERMS.join('\n')}\n`;

const created = [];
after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh repository with a placeholder identity, plus helpers bound to it. */
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-guard-'));
  created.push(dir);
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(home, 'gitconfig'), '');

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const k = key.toUpperCase();
    if (k.startsWith('GIT_') || k.startsWith('AGENTBOARD_')) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    GIT_CEILING_DIRECTORIES: dir,
    AGENTBOARD_DENYLIST: LIST,
    AGENTBOARD_DENYLIST_FILE: path.join(home, 'no-such-list.txt'),
  });

  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q');
  git('config', 'user.name', 'Test Placeholder');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));

  const write = (rel, data) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  /** Runs the guard; `extra` adds variables, a value of null removes one. */
  const run = (args, extra = {}, { script = SCRIPT, cwd = repo } = {}) => {
    const childEnv = { ...env };
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) delete childEnv[k];
      else childEnv[k] = v;
    }
    return spawnSync(process.execPath, [script, ...args], { cwd, env: childEnv, encoding: 'utf8' });
  };
  return { dir, home, repo, git, write, run };
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Neither stdout nor stderr may contain a private term (or any extra string given). */
function assertNoLeak(r, extra = []) {
  const out = fold(`${r.stdout}\n${r.stderr}`);
  for (const t of [...TERMS, ...extra]) assert.ok(!out.includes(fold(t)), 'the output contains a private string');
}

test('staged content with a term fails without printing the term', () => {
  const { write, git, run } = tempRepo();
  write('notes.md', 'hello\nmet ZorbaCorp today\n');
  git('add', '.');
  const r = run(['--staged']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: notes\.md:2 matches entry #1/);
  assertNoLeak(r);
});

test('a staged path with a term is reported masked', () => {
  const { write, git, run } = tempRepo();
  write('docs/Quux-Project-plan.md', 'nothing private here\n');
  git('add', '.');
  const r = run(['--staged']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: docs\/\*\*\*-plan\.md:\(path\) matches entry #2/);
  assertNoLeak(r);
});

test('a clean staged file passes', () => {
  const { write, git, run } = tempRepo();
  write('src/a.js', 'export const a = 1;\n');
  git('add', '.');
  const r = run(['--staged']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
});

test('decomposed accents and UTF-16 files are caught', () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'signed by ÉLODIE\n');
  write('b.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('line one\r\nzorbacorp\r\n', 'utf16le')]));
  git('add', '.');
  const r = run(['--staged']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: a\.txt:1 matches entry #3/);
  assert.match(r.stderr, /denylist: b\.txt:2 matches entry #1/);
  assertNoLeak(r);
});

test('an author name with a term fails, without printing the identity', () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  const r = run(['--staged'], { GIT_AUTHOR_NAME: 'Elodie Tester' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /author name or e-mail matches entry #3/);
  assertNoLeak(r, ['Tester', 'test@example.invalid']);
});

test('author and committer e-mails must be allowed addresses', () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  const author = run(['--staged'], { GIT_AUTHOR_EMAIL: 'tester@mail.example.com' });
  assert.equal(author.status, 1, author.stderr);
  assert.match(author.stderr, /the author e-mail is not allowed/);
  assertNoLeak(author, ['tester@mail.example.com', 'mail.example.com']);
  const committer = run(['--staged'], { GIT_COMMITTER_EMAIL: 'tester@mail.example.com' });
  assert.equal(committer.status, 1, committer.stderr);
  assert.match(committer.stderr, /the committer e-mail is not allowed/);
  assertNoLeak(committer, ['tester@mail.example.com', 'mail.example.com']);
});

test('--message fails on a term in the commit message', () => {
  const { home, run } = tempRepo();
  const msg = path.join(home, 'COMMIT_EDITMSG');
  fs.writeFileSync(msg, 'feat: add the board\n\nFor the Quux-Project team.\n');
  const r = run(['--message', msg]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: commit message:3 matches entry #2/);
  assertNoLeak(r);
  fs.writeFileSync(msg, 'feat: add the board\n');
  assert.equal(run(['--message', msg]).status, 0);
});

test('--history catches a term that was committed and later removed', () => {
  const { write, git, run } = tempRepo();
  write('keep.txt', '');
  write('leak.txt', 'first line\nzorbacorp was here\n');
  write('Zorbacorp/.gitkeep', ''); // same (empty) content as keep.txt: only its path gives it away
  git('add', '.');
  git('commit', '-qm', 'add files');
  git('rm', '-q', 'leak.txt', 'Zorbacorp/.gitkeep');
  git('commit', '-qm', 'remove them');
  assert.equal(run(['--all']).status, 0);
  const r = run(['--history']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: history leak\.txt@[0-9a-f]{7}:2 matches entry #1/);
  assert.match(r.stderr, /denylist: history \*\*\*\/\.gitkeep@[0-9a-f]{7}:\(path\) matches entry #1/);
  assertNoLeak(r);
});

test('--history checks commit metadata, and passes on a clean history', () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'clean start');
  assert.equal(run(['--history']).status, 0);
  git('commit', '-q', '--allow-empty', '-m', 'chore: notes\n\nThanks to élodie.');
  const r = run(['--history']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: commit [0-9a-f]{7} metadata matches entry #3/);
  assertNoLeak(r);
});

test('--all scans tracked files and skips files deleted from the working tree', () => {
  const { write, git, run, repo } = tempRepo();
  write('a.txt', 'clean\n');
  write('gone.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  fs.rmSync(path.join(repo, 'gone.txt'));
  assert.equal(run(['--all']).status, 0);
  write('a.txt', 'now with zorbacorp\n');
  const r = run(['--all']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: a\.txt:1 matches entry #1/);
  assertNoLeak(r);
});

test('unknown modes and missing arguments print usage and exit 2', () => {
  const { run } = tempRepo();
  for (const args of [['--bogus'], [], ['--message'], ['--message', ''], ['--staged', 'extra']]) {
    const r = run(args);
    assert.equal(r.status, 2, `args: ${args.join(' ')}`);
    assert.match(r.stderr, /usage:/);
  }
});

test('a missing list fails closed', () => {
  const { run } = tempRepo();
  const r = run(['--all'], { AGENTBOARD_DENYLIST: null });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no denylist found/);
});

test('a wrongly encoded list fails loudly instead of scanning with garbage', () => {
  const { home, run } = tempRepo();
  const file = path.join(home, 'list-utf16-no-bom.txt');
  // UTF-16 without a BOM: ASCII terms come out full of NULs...
  fs.writeFileSync(file, Buffer.from('zorbacorp\nquux-project\n', 'utf16le'));
  const ascii = run(['--all'], { AGENTBOARD_DENYLIST: null, AGENTBOARD_DENYLIST_FILE: file });
  assert.equal(ascii.status, 1, ascii.stderr);
  assert.match(ascii.stderr, /control character/);
  assertNoLeak(ascii);
  // ...and accented ones are not even valid UTF-8.
  fs.writeFileSync(file, Buffer.from(LIST, 'utf16le'));
  const accented = run(['--all'], { AGENTBOARD_DENYLIST: null, AGENTBOARD_DENYLIST_FILE: file });
  assert.equal(accented.status, 1, accented.stderr);
  assert.match(accented.stderr, /not valid UTF-8/);
  assertNoLeak(accented);
});

test('outside a repository the scan fails closed', () => {
  const { home, run } = tempRepo();
  const r = run(['--all'], {}, { cwd: home });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /git rev-parse failed/);
});

test('the guard still runs when started through a linked path', () => {
  const { dir, write, git, run } = tempRepo();
  // Link to a temp copy of scripts/, never to the real folder, so cleanup cannot reach it.
  const copy = path.join(dir, 'scripts-copy');
  fs.cpSync(path.dirname(SCRIPT), copy, { recursive: true });
  const link = path.join(dir, 'linked-scripts');
  fs.symlinkSync(copy, link, 'junction'); // a junction on Windows, a directory symlink elsewhere
  write('notes.md', 'zorbacorp\n');
  git('add', '.');
  const r = run(['--staged'], {}, { script: path.join(link, path.basename(SCRIPT)) });
  fs.unlinkSync(link);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /matches entry #1/);
  assertNoLeak(r);
});
