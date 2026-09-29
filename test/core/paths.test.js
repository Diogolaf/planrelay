import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBoard, samePath, toRepoPath, currentBranch, lockKey } from '../../src/core/paths.js';
import { gitEnv, tempDir, tempRepo } from '../helpers.js';

const WIN = process.platform === 'win32';
const FOLDS_CASE = WIN || process.platform === 'darwin';

const made = [];
/** Remembers a temp folder so it is removed when the file's tests end. */
const track = (dir) => (made.push(dir), dir);
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

/** Options that keep a test away from any repository or board above its temp folder (a ~/.git, for example). */
const isolated = (dir, home, extra = {}) => ({ home, env: { GIT_CEILING_DIRECTORIES: path.dirname(dir) }, ...extra });

/** A worktree whose `.git` file holds a relative gitdir (git's --relative-paths, or rewritten by hand on older git). */
function relativeWorktree(repo, wt) {
  try {
    git(repo, 'worktree', 'add', '-q', '--relative-paths', wt);
  } catch {
    git(repo, 'worktree', 'add', '-q', wt);
  }
  const file = path.join(wt, '.git');
  const target = /^gitdir: ([^\r\n]+)/.exec(fs.readFileSync(file, 'utf8'))[1];
  if (path.isAbsolute(target)) fs.writeFileSync(file, `gitdir: ${path.relative(wt, target).split(path.sep).join('/')}\n`);
  assert.ok(!path.isAbsolute(/^gitdir: ([^\r\n]+)/.exec(fs.readFileSync(file, 'utf8'))[1]));
}

test('currentBranch reads HEAD', () => {
  const repo = track(tempRepo());
  git(repo, 'checkout', '-q', '-b', 'feature/filters');
  assert.equal(currentBranch(resolveBoard(repo).gitDir), 'feature/filters');
  assert.equal(currentBranch(null), null);
});

test('currentBranch gives a 12-character commit id on a detached HEAD', () => {
  const repo = track(tempRepo());
  git(repo, 'checkout', '-q', '--detach');
  const id = git(repo, 'rev-parse', 'HEAD');
  assert.equal(currentBranch(resolveBoard(repo).gitDir), id.slice(0, 12));
});

test('currentBranch is null for the reftable placeholder and for a HEAD it cannot parse', () => {
  const dir = track(tempDir());
  const head = path.join(dir, 'HEAD');
  fs.writeFileSync(head, 'ref: refs/heads/.invalid\n');
  assert.equal(currentBranch(dir), null);
  fs.writeFileSync(head, 'not a ref\n');
  assert.equal(currentBranch(dir), null);
  fs.writeFileSync(head, 'ref: refs/heads/main\nref: refs/heads/other\n');
  assert.equal(currentBranch(dir), null);
  fs.rmSync(head);
  assert.equal(currentBranch(dir), null);
});

test('inside a repository the board lives in the git directory', () => {
  const repo = track(tempRepo());
  fs.mkdirSync(path.join(repo, 'src'));
  for (const cwd of [repo, path.join(repo, 'src')]) {
    const b = resolveBoard(cwd);
    assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
    assert.ok(samePath(b.repoRoot, repo));
    assert.equal(b.projectName, path.basename(repo));
    assert.equal(b.inGit, true);
    assert.equal(b.configRoot, repo);
  }
});

test('every worktree shares the main repository board', () => {
  const repo = track(tempRepo());
  const wt = path.join(track(tempDir()), 'feature-x');
  git(repo, 'worktree', 'add', '-q', wt);
  const b = resolveBoard(wt);
  assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
  assert.ok(samePath(b.repoRoot, wt));
  assert.equal(b.projectName, path.basename(repo));
  assert.ok(samePath(b.configRoot, repo)); // shared settings come from the main worktree
});

test('a worktree with a relative gitdir shares the main repository board', () => {
  const repo = track(tempRepo());
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-wt`);
  track(wt);
  relativeWorktree(repo, wt);
  const b = resolveBoard(wt);
  assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
  assert.ok(samePath(b.gitDir, path.join(repo, '.git', 'worktrees', path.basename(wt))));
  assert.equal(b.repoRoot, wt);
  assert.equal(b.projectName, path.basename(repo));
});

test('a relative gitdir is resolved from the real folder when reached through a junction or symlink', (t) => {
  const base = track(tempDir());
  const repo = path.join(base, 'real', 'shop');
  const wt = path.join(base, 'real', 'shop-wt');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  relativeWorktree(repo, wt);
  const link = path.join(base, 'link');
  try {
    fs.symlinkSync(wt, link, 'junction'); // a junction on Windows (no admin rights needed), a symlink elsewhere
  } catch (err) {
    t.skip(`cannot create a link here: ${err.code}`);
    return;
  }
  const b = resolveBoard(link);
  assert.equal(b.inGit, true);
  assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
  assert.equal(b.repoRoot, link);
  assert.equal(b.projectName, 'shop');
  assert.ok(samePath(link, wt));
  assert.ok(!samePath(link, repo));
});

test('a submodule has its own board in its git dir', () => {
  const lib = track(tempRepo());
  const app = track(tempRepo());
  git(app, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib.split(path.sep).join('/'), 'libs/lib');
  const sub = path.join(app, 'libs', 'lib');
  const b = resolveBoard(sub);
  const modules = path.join(app, '.git', 'modules', 'libs', 'lib');
  assert.equal(b.inGit, true);
  assert.ok(samePath(b.gitDir, modules));
  assert.ok(samePath(b.boardDir, path.join(modules, 'agentboard')));
  assert.equal(b.repoRoot, sub);
  assert.equal(b.projectName, 'lib');
  assert.equal(b.configRoot, sub);
  assert.equal(currentBranch(b.gitDir), git(sub, 'rev-parse', '--abbrev-ref', 'HEAD'));
});

test('an empty .git folder is skipped and the walk reaches the outer repository', () => {
  const repo = track(tempRepo());
  const pkg = path.join(repo, 'pkg');
  fs.mkdirSync(path.join(pkg, '.git'), { recursive: true });
  const b = resolveBoard(pkg);
  assert.equal(b.inGit, true);
  assert.ok(samePath(b.boardDir, path.join(repo, '.git', 'agentboard')));
  assert.ok(samePath(b.repoRoot, repo));
});

test('a .git file that is malformed or points to no git dir falls back to the home board', () => {
  const base = track(tempDir());
  const home = track(tempDir());
  const other = track(tempRepo());
  const missing = path.join(base, 'missing');
  fs.mkdirSync(path.join(base, 'no-head'));
  const cases = [
    `gitdir: ${path.join(missing, '.git')}\n`,
    'gitdir: ../missing/.git\n',
    `gitdir: ${path.join(base, 'no-head')}\n`,
    'not a git file\n',
    `# comment\ngitdir: ${path.join(other, '.git')}\n`,
    ` gitdir: ${path.join(other, '.git')}\n`,
  ];
  cases.forEach((content, i) => {
    const dir = path.join(base, `case-${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.git'), content);
    const b = resolveBoard(dir, isolated(base, home));
    assert.equal(b.inGit, false, content);
    assert.equal(b.gitDir, null);
    assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')), content);
    assert.equal(b.repoRoot, dir);
  });
  assert.equal(fs.existsSync(missing), false);
});

test('GIT_CEILING_DIRECTORIES stops the walk like git does', () => {
  const repo = track(tempRepo());
  const home = track(tempDir());
  const deep = path.join(repo, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(resolveBoard(deep, { home, env: {} }).inGit, true);
  for (const ceiling of [path.join(repo, 'a'), repo, ['relative', path.join(repo, 'a')].join(path.delimiter)]) {
    const b = resolveBoard(deep, { home, env: { GIT_CEILING_DIRECTORIES: ceiling } });
    assert.equal(b.inGit, false, ceiling);
    assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')));
  }
  // git itself agrees that a ceiling is never checked when it lies above the working folder
  assert.throws(() => execFileSync('git', ['rev-parse', '--git-dir'], {
    cwd: deep, env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: repo }, stdio: 'ignore',
  }));
  // the working folder itself is always checked, even when it is a ceiling
  assert.equal(resolveBoard(repo, { home, env: { GIT_CEILING_DIRECTORIES: repo } }).inGit, true);
});

test('on Windows, a folder inside the home folder ignores a .git above the home folder', { skip: !WIN && 'Windows only (POSIX checks the owner)' }, () => {
  const outer = track(tempRepo());
  const home = path.join(outer, 'home');
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const b = resolveBoard(cwd, isolated(outer, home));
  assert.equal(b.inGit, false);
  assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')));
  // a repository at the home folder itself (dotfiles) still counts
  git(home, 'init', '-q');
  const d = resolveBoard(cwd, isolated(outer, home));
  assert.equal(d.inGit, true);
  assert.equal(d.repoRoot, home);
  // outside the home folder the outer repository is used
  assert.equal(resolveBoard(path.join(outer), isolated(outer, home)).inGit, true);
});

test('outside git the board lives under the home folder, keyed by path hash', () => {
  const dir = track(tempDir());
  const home = track(tempDir());
  const b = resolveBoard(dir, isolated(dir, home));
  assert.equal(b.inGit, false);
  assert.equal(b.gitDir, null);
  assert.equal(b.repoRoot, dir);
  assert.equal(b.projectName, path.basename(dir));
  assert.equal(b.configRoot, dir);
  assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')));
  assert.match(path.basename(b.boardDir), /^[0-9a-f]{64}$/);
});

test('outside git the board does not depend on how the folder is spelled', { skip: !WIN && 'Windows only' }, () => {
  const dir = track(tempDir());
  const home = track(tempDir());
  const opts = isolated(dir, home);
  const expected = resolveBoard(dir, opts).boardDir;
  const lowerDrive = dir[0].toLowerCase() + dir.slice(1);
  const upperDrive = dir[0].toUpperCase() + dir.slice(1);
  for (const spelling of [lowerDrive, upperDrive, dir.toUpperCase(), `${dir}\\`, dir.split('\\').join('/')]) {
    const b = resolveBoard(spelling, opts);
    assert.equal(b.boardDir, expected, spelling);
    assert.equal(b.repoRoot, path.resolve(spelling));
  }
  assert.ok(samePath(lowerDrive, dir.toUpperCase()));
});

test('outside git a subfolder reuses the board of the nearest project folder', () => {
  const base = track(tempDir());
  const home = track(tempDir());
  const opts = isolated(base, home);

  // a folder with a .agentboard/ config folder
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, '.agentboard'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
  const top = resolveBoard(proj, opts);
  const deep = resolveBoard(path.join(proj, 'src', 'deep'), opts);
  assert.equal(deep.boardDir, top.boardDir);
  assert.equal(deep.repoRoot, proj);
  assert.equal(deep.projectName, 'proj');
  assert.equal(deep.configRoot, proj);

  // a folder that already has a board
  const notes = path.join(base, 'notes');
  const sub = path.join(notes, 'drafts');
  fs.mkdirSync(sub, { recursive: true });
  const board = resolveBoard(notes, opts).boardDir;
  assert.notEqual(resolveBoard(sub, opts).boardDir, board);
  fs.mkdirSync(board, { recursive: true });
  const reused = resolveBoard(sub, opts);
  assert.equal(reused.boardDir, board);
  assert.equal(reused.repoRoot, notes);

  // no marker: the host's project folder anchors the board, and folders outside it keep their own
  const app = path.join(base, 'app');
  const lib = path.join(app, 'lib');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(elsewhere);
  const anchored = resolveBoard(lib, { ...opts, projectDir: app });
  assert.equal(anchored.repoRoot, app);
  assert.equal(anchored.projectName, 'app');
  assert.equal(anchored.boardDir, resolveBoard(app, opts).boardDir);
  assert.equal(resolveBoard(elsewhere, { ...opts, projectDir: app }).repoRoot, elsewhere);
  assert.equal(resolveBoard(lib, opts).repoRoot, lib);
});

test('inside git, every folder in the host project folder gets the project board (one session, one board)', () => {
  const project = track(tempRepo());
  const lib = track(tempRepo());
  git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', lib.split(path.sep).join('/'), 'libs/lib');
  const submodule = path.join(project, 'libs', 'lib');
  const nested = path.join(project, 'tools', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q');

  const withProject = { projectDir: project };
  const mcp = resolveBoard(project, withProject);
  assert.ok(samePath(mcp.boardDir, path.join(project, '.git', 'agentboard')));
  for (const cwd of [submodule, nested, path.join(project, 'tools'), project]) {
    const b = resolveBoard(cwd, withProject);
    assert.equal(b.boardDir, mcp.boardDir, cwd);
    assert.equal(b.repoRoot, project, cwd);
    assert.equal(b.gitDir, mcp.gitDir, cwd);
    assert.equal(b.configRoot, project, cwd);
  }
  // without a project folder, the submodule and the nested repository have their own boards
  assert.ok(samePath(resolveBoard(submodule).boardDir, path.join(project, '.git', 'modules', 'libs', 'lib', 'agentboard')));
  assert.ok(samePath(resolveBoard(nested).boardDir, path.join(nested, '.git', 'agentboard')));
  // a folder outside the project folder is resolved from itself
  const other = track(tempRepo());
  assert.ok(samePath(resolveBoard(other, withProject).boardDir, path.join(other, '.git', 'agentboard')));
});

test('a worktree inside the host project folder shares its board but keeps its own root and branch', () => {
  const project = track(tempRepo());
  const main = git(project, 'rev-parse', '--abbrev-ref', 'HEAD');
  const wt = path.join(project, '.worktrees', 'feat');
  git(project, 'worktree', 'add', '-q', '-b', 'feat', wt);
  fs.mkdirSync(path.join(wt, 'src'));

  const withProject = { projectDir: project };
  const mcp = resolveBoard(project, withProject);
  const direct = resolveBoard(wt, { projectDir: wt }); // an agent started in the worktree itself
  for (const cwd of [wt, path.join(wt, 'src')]) {
    const b = resolveBoard(cwd, withProject);
    assert.equal(b.boardDir, mcp.boardDir, cwd);
    assert.ok(samePath(b.boardDir, direct.boardDir), cwd);
    assert.equal(b.repoRoot, wt, cwd);
    assert.ok(samePath(b.gitDir, direct.gitDir), cwd);
    assert.equal(currentBranch(b.gitDir), 'feat', cwd);
    assert.equal(toRepoPath(b.repoRoot, path.join(wt, 'src', 'a.js')), 'src/a.js', cwd);
    assert.equal(b.configRoot, project, cwd);
    assert.equal(b.projectName, mcp.projectName, cwd);
  }
  assert.equal(mcp.repoRoot, project);
  assert.equal(currentBranch(mcp.gitDir), main);
  assert.ok(samePath(direct.configRoot, project));
});

test('outside git, every folder in the host project folder gets the project board (one session, one board)', () => {
  const base = track(tempDir());
  const home = track(tempDir());
  const opts = isolated(base, home);
  const workspace = path.join(base, 'workspace');
  const app = path.join(workspace, 'app');
  const pkg = path.join(app, 'pkg'); // has its own .agentboard/
  const old = path.join(app, 'old'); // has an older board of its own
  const deep = path.join(app, 'src', 'deep');
  const other = path.join(base, 'other'); // outside the project folder, with its own .agentboard/
  for (const dir of [path.join(pkg, '.agentboard'), path.join(pkg, 'x'), old, deep, path.join(other, '.agentboard'), path.join(other, 'x')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(resolveBoard(old, opts).boardDir, { recursive: true });

  const withProject = { ...opts, projectDir: app };
  const mcp = resolveBoard(app, withProject);
  assert.equal(mcp.repoRoot, app);
  for (const cwd of [pkg, path.join(pkg, 'x'), old, deep]) {
    const b = resolveBoard(cwd, withProject);
    assert.equal(b.boardDir, mcp.boardDir, cwd);
    assert.equal(b.repoRoot, app, cwd);
  }
  // without a project folder each subfolder keeps its own marker or board
  assert.equal(resolveBoard(path.join(pkg, 'x'), opts).repoRoot, pkg);
  assert.equal(resolveBoard(old, opts).repoRoot, old);
  // a folder outside the project folder is resolved from itself
  assert.equal(resolveBoard(path.join(other, 'x'), withProject).repoRoot, other);
  // a folder reached through a link is still inside the project folder
  const link = path.join(base, 'link');
  let linked = true;
  try {
    fs.symlinkSync(deep, link, 'junction');
  } catch {
    linked = false; // links unavailable here
  }
  if (linked) assert.equal(resolveBoard(link, withProject).boardDir, mcp.boardDir);
  // the search goes up from the project folder, so a board in its parent is shared by the whole session
  const parentBoard = resolveBoard(workspace, opts).boardDir;
  fs.mkdirSync(parentBoard, { recursive: true });
  assert.equal(resolveBoard(app, withProject).boardDir, parentBoard);
  assert.equal(resolveBoard(deep, withProject).boardDir, parentBoard);
});

test("a .git owned by another user stops the search, like git's dubious-ownership check", () => {
  const outer = track(tempRepo());
  const home = track(tempDir());
  const inner = path.join(outer, 'vendor', 'inner');
  const empty = path.join(outer, 'vendor', 'empty');
  const linked = path.join(outer, 'vendor', 'linked');
  fs.mkdirSync(path.join(inner, 'src'), { recursive: true });
  fs.mkdirSync(path.join(empty, '.git'), { recursive: true });
  fs.mkdirSync(linked);
  git(inner, 'init', '-q');
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(outer, '.git')}\n`);
  const me = 4242;
  const strangers = [inner, empty, linked].map((d) => path.join(d, '.git'));
  const opts = { ...isolated(outer, home), uid: me, ownerOf: (file) => (strangers.some((s) => samePath(s, file)) ? 1 : me) };

  const own = resolveBoard(path.join(inner, 'src'), { ...opts, ownerOf: () => me });
  assert.ok(samePath(own.boardDir, path.join(inner, '.git', 'agentboard')));
  // a repository owned by someone else is not used, and neither is the repository around it
  for (const cwd of [path.join(inner, 'src'), linked]) {
    const b = resolveBoard(cwd, opts);
    assert.equal(b.inGit, false, cwd);
    assert.ok(b.boardDir.startsWith(path.join(home, '.agentboard', 'boards')), cwd);
  }
  // a .git folder that is not a repository is passed over, whoever owns it
  assert.ok(samePath(resolveBoard(empty, opts).boardDir, path.join(outer, '.git', 'agentboard')));
  // null turns the check off
  assert.equal(resolveBoard(path.join(inner, 'src'), { ...opts, uid: null }).inGit, true);
  // by default the owner comes from the file system
  const owner = fs.statSync(path.join(outer, '.git')).uid;
  assert.equal(resolveBoard(outer, { ...isolated(outer, home), uid: owner }).inGit, true);
  assert.equal(resolveBoard(outer, { ...isolated(outer, home), uid: owner + 1 }).inGit, false);
});

test('a bare repository with worktrees: the name drops .git or takes the parent of .bare, and each worktree holds its own settings', () => {
  const origin = track(tempRepo());
  const base = track(tempDir());

  git(base, 'clone', '-q', '--bare', origin, 'shop.git');
  const main = path.join(base, 'shop-main');
  git(path.join(base, 'shop.git'), 'worktree', 'add', '-q', main);
  const b = resolveBoard(main);
  assert.equal(b.projectName, 'shop');
  assert.ok(samePath(b.boardDir, path.join(base, 'shop.git', 'agentboard')));
  assert.equal(b.configRoot, main); // no main checkout: the worktree itself

  const tools = path.join(base, 'tools');
  fs.mkdirSync(tools);
  git(tools, 'clone', '-q', '--bare', origin, '.bare');
  fs.writeFileSync(path.join(tools, '.git'), 'gitdir: ./.bare\n');
  const wt = path.join(tools, 'wt-a');
  git(path.join(tools, '.bare'), 'worktree', 'add', '-q', wt);
  for (const cwd of [wt, tools]) {
    const r = resolveBoard(cwd);
    assert.equal(r.projectName, 'tools', cwd);
    assert.ok(samePath(r.boardDir, path.join(tools, '.bare', 'agentboard')), cwd);
    assert.equal(r.configRoot, cwd);
  }
});

test('at a drive or file-system root the project name is the root itself', () => {
  const home = track(tempDir());
  const root = path.parse(home).root;
  // inside git or not, the name is never empty
  assert.equal(resolveBoard(root, { home, env: {} }).projectName, WIN ? root.slice(0, 2) : '/');
});

test('toRepoPath gives forward-slash repo-relative paths', () => {
  const root = track(tempDir());
  assert.equal(toRepoPath(root, path.join(root, 'src', 'a.js')), 'src/a.js');
  assert.equal(toRepoPath(root, 'src/b.js'), 'src/b.js');
});

test('toRepoPath is null outside the root, but not for a folder whose name starts with two dots', () => {
  const root = track(tempDir());
  assert.equal(toRepoPath(root, path.join(root, '..', 'other', 'x.js')), null);
  assert.equal(toRepoPath(root, '../x.js'), null);
  assert.equal(toRepoPath(root, path.dirname(root)), null);
  assert.equal(toRepoPath(root, path.join(root, '..foo', 'y.js')), '..foo/y.js');
  assert.equal(toRepoPath(root, '..foo/y.js'), '..foo/y.js');
  if (WIN) {
    const drive = root[0].toUpperCase() === 'Q' ? 'R' : 'Q';
    assert.equal(toRepoPath(root, `${drive}:\\x\\y.js`), null);
    assert.equal(toRepoPath(root.toUpperCase(), path.join(root, 'Src', 'App.JS')), 'Src/App.JS');
  }
});

test('lockKey folds case where the file system ignores it', () => {
  assert.equal(lockKey('Src/App.JS'), FOLDS_CASE ? 'src/app.js' : 'Src/App.JS');
  assert.equal(lockKey('src/app.js'), 'src/app.js');
  assert.equal(lockKey(null), null);
});
