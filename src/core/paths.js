import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, NAME } from '../name.js';

// Everything here runs on every hook call, so it reads the file system instead of spawning `git`
// (a process spawn alone costs 30–60 ms on Windows).

/** File systems that ignore case by default. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

/** A comparable form of an absolute path: NFC, and lower case where the file system ignores case. */
function fold(p) {
  const n = p.normalize('NFC');
  return FOLD_CASE ? n.toLowerCase() : n;
}

/** The real path (symlinks, junctions, 8.3 names and letter case resolved), or the path itself if that fails. */
function realOrSelf(abs) {
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** Comparable key of any path, following links when it exists. */
function pathKey(p) {
  return fold(realOrSelf(path.resolve(p)));
}

/** True when folded path `child` is `parent` or lies inside it. */
function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function statOrNull(p) {
  try {
    return fs.statSync(p, { throwIfNoEntry: false }) ?? null;
  } catch {
    return null; // EACCES, ENOTDIR, ELOOP...: treated as absent
  }
}

const isFile = (p) => statOrNull(p)?.isFile() === true;
const isDir = (p) => statOrNull(p)?.isDirectory() === true;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Name of a folder; at a drive or file-system root, the root itself ('Q:', '/'). A UNC share root gives the share name ('share'). */
function baseName(p) {
  const name = path.basename(p);
  if (name) return name;
  const root = path.parse(p).root || p;
  return root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
}

/** GIT_CEILING_DIRECTORIES as folded keys; relative entries are ignored, like git does. */
function ceilingKeys(value) {
  const keys = new Set();
  for (const entry of (value ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const abs = path.resolve(entry);
    keys.add(fold(abs));
    keys.add(fold(realOrSelf(abs)));
  }
  return keys;
}

/**
 * The git dir and its common dir, or null unless it looks like one: it must hold a HEAD, and a
 * `commondir` file must be readable and point to a folder that holds a HEAD too.
 * @returns {{ gitDir: string, commonDir: string } | null}
 */
function gitDirInfo(gitDir) {
  if (!isFile(path.join(gitDir, 'HEAD'))) return null;
  let commonDir = gitDir;
  try {
    const rel = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').replace(/[\r\n]+$/, '');
    commonDir = path.resolve(gitDir, rel);
  } catch (err) {
    if (err?.code !== 'ENOENT') return null; // unreadable: do not guess
    // no commondir: not a linked worktree (a main repository or a submodule), so its own git dir is shared
  }
  if (commonDir !== gitDir && !isFile(path.join(commonDir, 'HEAD'))) return null;
  return { gitDir, commonDir };
}

/** The git dir a `.git` file points to (`gitdir: <path>` on the first line), or null. */
function readGitFile(dir, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir: ([^\r\n]+)/.exec(text);
  if (!m) return null;
  if (path.isAbsolute(m[1])) return path.resolve(m[1]);
  // Git resolves a relative gitdir from the real folder of the .git file, not the spelling we walked (junctions, symlinks).
  return path.resolve(realOrSelf(dir), m[1]);
}

/**
 * Walks up from `start` to the nearest `.git`, like git's own discovery. A `.git` directory without
 * a HEAD is skipped (git keeps looking further up). A `.git` file (worktree or submodule) that
 * cannot be read or points to something that is not a git dir ends the search: git refuses such a
 * folder, and guessing could put a board in a folder that does not exist.
 *
 * Ownership, like git's safe.directory: on POSIX, a `.git` owned by another user ends the search
 * (git fails with "dubious ownership" there too), so the board falls back to the home folder. There
 * is no safe.directory escape hatch and no SUDO_UID handling (git lets root use a repository owned
 * by the user who ran sudo; here that repository is refused). On Windows, owners cannot be read
 * without a process spawn or native code, so a folder inside the home folder never uses a `.git`
 * above the home folder (`C:\Users\.git`, `C:\.git`), the places another account could plant one.
 * Remaining risk: on Windows, a folder outside the home folder can still pick up a `.git` planted
 * higher up (for example `D:\.git` on a shared drive); the gitdir that a `.git` file points to is
 * not owner-checked; the home-folder rule and GIT_CEILING_DIRECTORIES compare spellings (plus each
 * ceiling's real path), so a working folder reached through a junction, symlink or 8.3 short name
 * can walk past them; GIT_DIR, GIT_WORK_TREE and GIT_DISCOVERY_ACROSS_FILESYSTEM are ignored.
 *
 * @param {string} start absolute path
 * @param {{ ceilings: Set<string>, stopAt: string | null, uid: number | null, ownerOf?: (file: string) => number }} limits
 *   ceilings: folded GIT_CEILING_DIRECTORIES (git never checks a ceiling that lies above `start`,
 *   nor anything higher); stopAt: folded folder that is the last one checked; uid: the user who must
 *   own a `.git` (null: no owner check); ownerOf: owner of a `.git` (default: its stat uid).
 * @returns {{ top: string, gitDir: string, commonDir: string } | null}
 */
function findGit(start, { ceilings, stopAt, uid, ownerOf }) {
  const foreign = (file, stat) => uid !== null && (ownerOf ? ownerOf(file) : stat.uid) !== uid;
  let dir = start;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    const stat = statOrNull(dotGit);
    if (stat?.isDirectory()) {
      const found = gitDirInfo(dotGit);
      // like git, a folder that is not a git dir is passed over whoever owns it; a real one owned by someone else stops the search
      if (found) return foreign(dotGit, stat) ? null : { top: dir, ...found };
    } else if (stat?.isFile()) {
      if (foreign(dotGit, stat)) return null;
      const gitDir = readGitFile(dir, dotGit);
      const found = gitDir && gitDirInfo(gitDir);
      return found ? { top: dir, ...found } : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (stopAt !== null && fold(dir) === stopAt) return null;
    if (ceilings.size > 0 && ceilings.has(fold(parent))) return null;
    dir = parent;
  }
}

/**
 * Project name from the shared git dir: `shop/.git` and `shop/.bare` → 'shop', `shop.git` → 'shop',
 * a submodule's `.git/modules/lib` → 'lib'.
 */
function repoName(commonDir) {
  const base = path.basename(commonDir);
  if (base.startsWith('.')) return baseName(path.dirname(commonDir));
  if (base.length > 4 && base.endsWith('.git')) return base.slice(0, -4);
  return baseName(commonDir);
}

/** True when a git config file says `bare = true`. */
function isBare(commonDir) {
  try {
    return /^\s*bare\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(commonDir, 'config'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The folder whose `.planrelay/` settings apply to the whole shared board: the main worktree.
 * - In the main worktree or a submodule (its git dir is the common dir): its own top folder.
 * - In a linked worktree: the folder holding the common dir when that is a `.git` folder of a
 *   repository that is not bare; otherwise (a bare repository, including a bare one named `.git`,
 *   or a `.bare` layout) there is no main checkout, and the worktree's own top folder is used.
 *   Known gap: for a linked worktree of a `--separate-git-dir` repository whose git dir is named
 *   `.git`, this gives the folder holding that git dir, not the main checkout, which git does not
 *   record.
 */
function configRootOf({ top, gitDir, commonDir }) {
  if (gitDir === commonDir) return top;
  if (path.basename(commonDir) !== '.git' || isBare(commonDir)) return top;
  return path.dirname(commonDir);
}

/**
 * The folder a board belongs to outside git: `start`, unless `start` has no `.planrelay/` folder
 * and a folder above it has one; then the nearest such folder, so a `cd` into a subfolder of a
 * marked project keeps its board. Only that deliberate marker counts. Existing boards never do:
 * every session creates one, so a board above `start` only means a session once ran there (one run
 * in Desktop must not capture Desktop/recipes). The search never considers a file-system root, the
 * home folder or its parents (the home folder holds the global `.planrelay/`), or a
 * GIT_CEILING_DIRECTORIES entry, and stops there.
 * @returns {{ root: string, key: string }} root in the caller's spelling where possible; key hashes to the board folder
 */
function nonGitFolder(start, { home, ceilings }) {
  const real = realOrSelf(start);
  if (isDir(path.join(real, CONFIG_DIR))) return { root: start, key: fold(real) };
  const homeKey = fold(realOrSelf(home));
  // Every parent of a real path is a real path, so parents need no realpath call of their own.
  let dir = real;
  for (let up = 1; ; up++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const key = fold(dir);
    if (path.dirname(dir) === dir || within(homeKey, key) || ceilings.has(key)) break;
    if (isDir(path.join(dir, CONFIG_DIR))) {
      let spelled = start;
      for (let i = 0; i < up; i++) spelled = path.dirname(spelled);
      return { root: fold(realOrSelf(spelled)) === key ? spelled : dir, key };
    }
  }
  return { root: start, key: fold(real) };
}

/**
 * The folder the search starts from: `projectDir` when `abs` lies inside it (compared on
 * normalized real paths), else `abs`.
 */
function startFolder(abs, projectDir) {
  if (!projectDir) return abs;
  const project = path.resolve(projectDir);
  return within(fold(abs), fold(project)) || within(pathKey(abs), pathKey(project)) ? project : abs;
}

/**
 * Where the board for a folder lives (§6): in the shared git dir inside git, else under
 * `~/.planrelay/boards/<sha256 of the folder's normalized real path>/`.
 *
 * One session, one board: when `cwd` lies inside `projectDir`, the search starts from `projectDir`
 * instead, inside git or not. Hooks pass the agent's current folder and the MCP server passes the
 * project folder, so a `cd` into a submodule, a nested repository or a subfolder with its own
 * `.planrelay/` must not give the two a different board. The one exception keeps the board and
 * changes only the local view: when `cwd` is in a linked worktree of the same repository (for
 * example `project/.worktrees/feat`), `repoRoot` and `gitDir` are that worktree's, so the branch
 * and repo-relative paths match an agent started there. A `cwd` outside `projectDir` is resolved
 * from itself.
 * @param {string} cwd
 * @param {{ home?: string, projectDir?: string, env?: Record<string, string | undefined>, uid?: number | null, ownerOf?: (file: string) => number }} [opts]
 *   home: the home folder (default os.homedir()); projectDir: the host's project folder (for
 *   example CLAUDE_PROJECT_DIR); env: for GIT_CEILING_DIRECTORIES (default process.env); uid: the
 *   user who must own a `.git` (default process.getuid(), none on Windows; null: no owner check);
 *   ownerOf: owner uid of a `.git` path (default: from its stat; for tests).
 * @returns {{ boardDir: string, repoRoot: string, configRoot: string, projectName: string, inGit: boolean, gitDir: string | null }}
 *   repoRoot: the working tree (or non-git folder) that file paths are relative to; configRoot: the
 *   folder whose `.planrelay/` settings apply to the board (the main worktree in git, else repoRoot).
 */
export function resolveBoard(cwd, opts = {}) {
  const home = path.resolve(opts.home ?? os.homedir());
  const abs = path.resolve(cwd);
  const start = startFolder(abs, opts.projectDir);
  const ceilings = ceilingKeys((opts.env ?? process.env).GIT_CEILING_DIRECTORIES);
  const homeKey = fold(home);
  const uid = opts.uid !== undefined ? opts.uid : UID;
  const search = (from) => findGit(from, {
    ceilings, uid, ownerOf: opts.ownerOf, stopAt: process.platform === 'win32' && within(fold(from), homeKey) ? homeKey : null,
  });
  const git = search(start);
  if (git) {
    let local = git;
    if (start !== abs) {
      const here = search(abs);
      if (here && here.gitDir !== git.gitDir && samePath(here.commonDir, git.commonDir)) local = here;
    }
    return {
      boardDir: path.join(git.commonDir, NAME),
      repoRoot: local.top,
      configRoot: configRootOf(local),
      projectName: repoName(git.commonDir),
      inGit: true,
      gitDir: local.gitDir,
    };
  }
  const { root, key } = nonGitFolder(start, { home, ceilings });
  return {
    boardDir: path.join(home, `.${NAME}`, 'boards', sha256(key)), repoRoot: root, configRoot: root, projectName: baseName(root), inGit: false, gitDir: null,
  };
}

/**
 * The checked-out branch, read from HEAD without spawning git; a 12-character commit id when
 * detached; null when HEAD cannot be read or parsed, or names the placeholder branch `.invalid`
 * that reftable repositories keep in HEAD.
 */
export function currentBranch(gitDir) {
  if (!gitDir) return null;
  let head;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1] === '.invalid' ? null : ref[1];
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head.slice(0, 12) : null;
}

/** Path equality on normalized forms: real path when it exists, NFC, and case-insensitive on Windows and macOS. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const x = path.resolve(a);
  const y = path.resolve(b);
  return fold(x) === fold(y) || pathKey(x) === pathKey(y);
}

/**
 * Repo-relative path with forward slashes, in the caller's letter case, used for file touches; null
 * for a file outside `repoRoot` (scratch files, temp folders, another drive). Paths are compared
 * as spelled, without resolving links: a file spelled through a junction or symlink (or by its real
 * path) when `repoRoot` is spelled the other way also gives null.
 */
export function toRepoPath(repoRoot, file) {
  const root = path.resolve(repoRoot);
  const rel = path.relative(root, path.resolve(root, file));
  if (path.isAbsolute(rel)) return null;
  const out = rel.split(path.sep).join('/');
  return out === '..' || out.startsWith('../') ? null : out;
}

/**
 * The key for file locks: a repo path in NFC (macOS and editors may spell accents decomposed),
 * case-folded where the file system ignores case (Windows, macOS).
 */
export function lockKey(repoPath) {
  if (!repoPath) return repoPath;
  return fold(repoPath);
}
