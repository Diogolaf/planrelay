// Integration tests: run the leak guard CLI as a child process inside throwaway git
// repositories. Every term, name and e-mail here is invented.
// Children never see the maintainer's setup: HOME/USERPROFILE point at the temp folder,
// inherited GIT_* and AGENTBOARD_* variables are dropped, and git ignores system and
// global config. So a test can never read the private list or touch this repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { tempDir } from '../helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-denylist.mjs');
const TERMS = ['zorbacorp', 'quux-project', 'Élodie']; // entries #1, #2, #3
const LIST = `# invented test terms\n${TERMS.join('\n')}\n`;

/** A fresh repository with a placeholder identity, plus helpers bound to it. */
function tempRepo() {
  const dir = tempDir();
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

  /** Runs git and returns the result; `extra` adds environment variables. */
  const gitRun = (args, extra = {}) => spawnSync('git', args, { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
  const git = (...args) => {
    const r = gitRun(args);
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
  /**
   * Turns on this repository's real hooks: .githooks and scripts/ are copied into the
   * work tree (and excluded from git), exactly where the hooks expect them.
   */
  const enableHooks = () => {
    fs.cpSync(path.join(REPO_ROOT, '.githooks'), path.join(repo, '.githooks'), { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(repo, 'scripts'), { recursive: true });
    for (const hook of fs.readdirSync(path.join(repo, '.githooks'))) fs.chmodSync(path.join(repo, '.githooks', hook), 0o755);
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.githooks/\nscripts/\n');
    git('config', 'core.hooksPath', '.githooks');
  };
  /**
   * Runs a real `git commit` through the hooks with a scripted editor: it prepends
   * `message` to git's template, as a person would, and keeps a copy of what it saw.
   */
  const commitWithEditor = (args, message) => {
    const editor = path.join(dir, 'editor.mjs');
    fs.writeFileSync(
      editor,
      "import fs from 'node:fs';\n" +
        'const file = process.argv[2];\n' +
        "const template = fs.readFileSync(file, 'utf8');\n" +
        'fs.writeFileSync(process.env.TEST_EDITOR_COPY, template);\n' +
        'fs.writeFileSync(file, process.env.TEST_EDITOR_MESSAGE + template);\n',
    );
    const slash = (p) => p.replace(/\\/g, '/');
    const seen = path.join(dir, 'editor-saw.txt');
    const r = gitRun(['commit', '-q', ...args], {
      GIT_EDITOR: `"${slash(process.execPath)}" "${slash(editor)}"`,
      TEST_EDITOR_MESSAGE: message,
      TEST_EDITOR_COPY: seen,
    });
    return { ...r, template: fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8') : '' };
  };
  const head = () => git('rev-parse', 'HEAD').trim();
  return { dir, home, repo, git, gitRun, write, run, enableHooks, commitWithEditor, head };
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
  write('a.txt', 'signed by E\u0301LODIE\n');
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
  for (const args of [['--bogus'], [], ['--message'], ['--message', ''], ['--staged', 'extra'], ['--tarball']]) {
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

test('--message ignores what git will not store, unless git keeps it', () => {
  const { home, git, run } = tempRepo();
  const msg = path.join(home, 'COMMIT_EDITMSG');
  const cut = '------------------------ >8 ------------------------';
  fs.writeFileSync(msg, `fix: tidy\n\n# deleted: docs/zorbacorp.md\n# ${cut}\n-zorbacorp\n`);
  // Editor commit (the default): comment lines and the diff below the scissors are dropped by git.
  assert.equal(run(['--message', msg]).status, 0);
  // No editor (-m, -F): git tells the hook with GIT_EDITOR=: and keeps comment lines.
  const noEditor = run(['--message', msg], { GIT_EDITOR: ':' });
  assert.equal(noEditor.status, 1, noEditor.stderr);
  assert.match(noEditor.stderr, /commit message:3 matches entry #1/);
  assertNoLeak(noEditor);
  // core.commentChar is honoured.
  git('config', 'core.commentChar', ';');
  fs.writeFileSync(msg, 'fix: tidy\n; zorbacorp in a comment\n');
  assert.equal(run(['--message', msg]).status, 0);
  git('config', '--unset', 'core.commentChar');
  // commit.cleanup=verbatim keeps comment lines, so they are scanned.
  git('config', 'commit.cleanup', 'verbatim');
  fs.writeFileSync(msg, `fix: tidy\n\n# deleted: docs/zorbacorp.md\n# ${cut}\n-zorbacorp\n`);
  const verbatim = run(['--message', msg]);
  assert.equal(verbatim.status, 1, verbatim.stderr);
  assert.match(verbatim.stderr, /commit message:3 matches entry #1/);
  assertNoLeak(verbatim);
});

test('real hooks: pre-commit blocks a staged term', () => {
  const { write, git, gitRun, enableHooks, head } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  enableHooks();
  const before = head();
  write('notes.md', 'met ZorbaCorp today\n');
  git('add', 'notes.md');
  const r = gitRun(['commit', '-q', '-m', 'add notes']);
  assert.notEqual(r.status, 0, 'the commit should be refused');
  assert.match(r.stderr, /denylist: notes\.md:1 matches entry #1/);
  assert.equal(head(), before);
  assertNoLeak(r);
});

test('real hooks: an editor commit that removes a leaking file passes, with or without -v', () => {
  const { write, git, enableHooks, commitWithEditor, head } = tempRepo();
  write('docs/zorbacorp-notes.md', 'zorbacorp was here\n');
  write('docs/other-zorbacorp.md', 'zorbacorp again\n');
  git('add', '.');
  git('commit', '-qm', 'add notes (before the guard)');
  enableHooks();

  git('rm', '-q', 'docs/zorbacorp-notes.md');
  const plain = commitWithEditor([], 'chore: remove the notes\n');
  assert.match(fold(plain.template), /deleted: +docs\/zorbacorp-notes\.md/, 'git lists the removed file in the template');
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(git('log', '-1', '--format=%s').trim(), 'chore: remove the notes');

  const before = head();
  git('rm', '-q', 'docs/other-zorbacorp.md');
  const verbose = commitWithEditor(['-v'], 'chore: remove the other notes\n');
  assert.match(verbose.template, / >8 /, 'git -v adds the scissors line and the diff');
  assert.equal(verbose.status, 0, verbose.stderr);
  assert.notEqual(head(), before);
});

test('real hooks: a term typed in the commit message is still blocked', () => {
  const { write, git, gitRun, enableHooks, commitWithEditor, head } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  enableHooks();
  const before = head();

  write('a.txt', 'still clean\n');
  git('add', 'a.txt');
  const typed = commitWithEditor([], 'chore: tidy\n\nThanks to the Zorbacorp team.\n');
  assert.notEqual(typed.status, 0, 'the commit should be refused');
  assert.match(typed.stderr, /denylist: commit message:3 matches entry #1/);
  assertNoLeak(typed);

  // With -m git keeps lines that start with '#', so they are scanned too.
  const dashM = gitRun(['commit', '-q', '-m', 'chore: tidy', '-m', '#42 follow-up for quux-project']);
  assert.notEqual(dashM.status, 0, 'the commit should be refused');
  assert.match(dashM.stderr, /denylist: commit message:3 matches entry #2/);
  assertNoLeak(dashM);
  assert.equal(head(), before);
});

test('--history refuses commit e-mails that are not allowed, without printing them', () => {
  const { write, git, gitRun, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  assert.equal(run(['--history']).status, 0);

  git('commit', '-q', '--allow-empty', '-m', 'by someone', '--author=Someone <someone@mail.example.com>');
  const author = run(['--history']);
  assert.equal(author.status, 1, author.stderr);
  assert.match(author.stderr, /denylist: commit [0-9a-f]{7} author e-mail is not allowed/);
  assert.doesNotMatch(author.stderr, /committer e-mail/);
  assertNoLeak(author, ['someone@mail.example.com', 'mail.example.com']);

  const r = gitRun(['commit', '-q', '--allow-empty', '-m', 'committed elsewhere'], { GIT_COMMITTER_EMAIL: 'robot@mail.example.com' });
  assert.equal(r.status, 0, r.stderr);
  const committer = run(['--history']);
  assert.equal(committer.status, 1, committer.stderr);
  assert.match(committer.stderr, /denylist: commit [0-9a-f]{7} committer e-mail is not allowed/);
  assertNoLeak(committer, ['robot@mail.example.com', 'mail.example.com']);
});

test('--history checks annotated tags: tagger e-mail and masked names', () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  git('tag', '-a', 'v1', '-m', 'first release');
  assert.equal(run(['--history']).status, 0);

  git('-c', 'user.email=tagger@mail.example.com', 'tag', '-a', 'v2', '-m', 'second release');
  git('tag', '-a', 'zorbacorp-v3', '-m', 'third release');
  const r = run(['--history']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: tag v2 tagger e-mail is not allowed/);
  assert.match(r.stderr, /denylist: tag \*\*\*-v3 metadata matches entry #1/);
  assert.match(r.stderr, /denylist: ref refs\/tags\/\*\*\*-v3 matches entry #1/);
  assert.doesNotMatch(r.stderr, /tag v1 /);
  assertNoLeak(r, ['tagger@mail.example.com', 'mail.example.com']);
});

test('--history refuses a shallow clone', () => {
  const { dir, repo, write, git, run } = tempRepo();
  write('a.txt', 'one\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  write('a.txt', 'two\n');
  git('commit', '-qam', 'two');
  const clone = path.join(dir, 'clone');
  git('clone', '-q', '--depth', '1', pathToFileURL(repo).href, clone);
  const r = run(['--history'], {}, { cwd: clone });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /shallow clone/);
});

test('--message with commit.cleanup=scissors scans the comment lines, which git keeps', () => {
  const { home, git, run } = tempRepo();
  const msg = path.join(home, 'COMMIT_EDITMSG');
  const cut = '------------------------ >8 ------------------------';
  git('config', 'commit.cleanup', 'scissors');
  fs.writeFileSync(msg, `fix: tidy\n\n# note: zorbacorp\n# ${cut}\n-quux-project\n`);
  const r = run(['--message', msg]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /commit message:3 matches entry #1/);
  assert.doesNotMatch(r.stderr, /entry #2/); // the diff below the scissors line is never stored
  assertNoLeak(r);
});

test("--history accepts GitHub's web committer, but never as an author", () => {
  const { write, git, gitRun, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  git('commit', '-qm', 'start');
  // a merge or an edit made on the website: the committer is GitHub itself
  const web = gitRun(['commit', '-q', '--allow-empty', '-m', 'merged on the web'],
    { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' });
  assert.equal(web.status, 0, web.stderr);
  assert.equal(run(['--history']).status, 0);

  git('commit', '-q', '--allow-empty', '-m', 'by nobody', '--author=GitHub <noreply@github.com>');
  const r = run(['--history']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: commit [0-9a-f]{7} author e-mail is not allowed/);
  assert.doesNotMatch(r.stderr, /committer e-mail/);
});

test("a local commit may not use GitHub's web committer address", () => {
  const { write, git, run } = tempRepo();
  write('a.txt', 'clean\n');
  git('add', '.');
  const r = run(['--staged'], { GIT_COMMITTER_EMAIL: 'noreply@github.com' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the committer e-mail is not allowed/);
});

/** A minimal ustar archive: one header block per file, its content padded to 512 bytes, two empty blocks. */
function tarOf(files) {
  const blocks = [];
  for (const { path: p, content, prefix = '', type = '0' } of files) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(p, 0, 100, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
    header.write(type, 156, 1, 'ascii');
    header.write('ustar', 257, 6, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('--tarball scans the paths and the contents of a packed package, without git', () => {
  const { home, run } = tempRepo();
  const tgz = path.join(home, 'pkg.tgz');
  fs.writeFileSync(tgz, zlib.gzipSync(tarOf([
    { path: 'package/README.md', content: 'hello\nmade at ZorbaCorp\n' },
    { path: 'package/docs/quux-project.md', content: 'clean\n' },
  ])));
  const r = run(['--tarball', tgz], {}, { cwd: home }); // home is not a repository
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /denylist: package\/README\.md:2 matches entry #1/);
  assert.match(r.stderr, /denylist: package\/docs\/\*\*\*\.md:\(path\) matches entry #2/);
  assert.match(r.stderr, /Remove them from the package\./);
  assertNoLeak(r);

  fs.writeFileSync(tgz, zlib.gzipSync(tarOf([{ path: 'package/README.md', content: 'hello\n' }])));
  assert.equal(run(['--tarball', tgz], {}, { cwd: home }).status, 0);
});

test('--tarball fails closed on a file that is not a package', () => {
  const { home, run } = tempRepo();
  const file = path.join(home, 'pkg.tgz');
  fs.writeFileSync(file, 'plain text');
  const bad = run(['--tarball', file]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /could not read the package/);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.alloc(1024)));
  const empty = run(['--tarball', file]);
  assert.equal(empty.status, 1, empty.stderr);
  assert.match(empty.stderr, /the package is empty/);
  assert.equal(run(['--tarball', path.join(home, 'missing.tgz')]).status, 1);
});
