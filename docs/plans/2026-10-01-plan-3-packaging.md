# agentboard plan 3: packaging, CI and release readiness

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the repository ready to publish: a plugin that installs cleanly from a marketplace in this repository, an npm package with exactly the runtime files, a leak guard that also covers pushes and the packed tarball, a hardened CI, a README for users, and a scripted acceptance run on a throwaway project.

**Architecture:**
- The plugin stays at the repository root. Its MCP server moves into `.claude-plugin/plugin.json`, next to a new `.claude-plugin/marketplace.json` whose only plugin has the source `./`.
- The repository root has no dependencies and no lockfile, so installing the plugin never runs a package install. Playwright moves to a development-only package in `test/ui/`.
- The leak guard (`scripts/check-denylist.mjs`) gains two modes: `--tarball` for the `npm pack` output and `--push` for a `pre-push` hook.
- The acceptance script drives real headless Claude Code sessions in a temp project and checks the board they leave behind.

**Tech stack:** Node.js 22+, ES modules with JSDoc, `node:test`, zero runtime dependencies. GitHub Actions for CI. Playwright only in `test/ui/`.

**Not in this plan's automatic run:** anything that publishes. Task 12 (final name, GitHub account, author rewrite, first push, npm publish) waits for the maintainer's decisions (spec §20) and is never started by a subagent.

---

## Ground rules for every task

- **No private data, ever.** Only invented names and data (the "recipes-app" example: Amber, Jade, Cobalt) appear in code, tests, fixtures, screenshots and docs. The commit hooks (denylist, identity, gitleaks) enforce this; never bypass them, and never use `--no-verify` on this repository.
- **Never read or touch `~/.agentboard-dev/`.** The leak guard reads it; you don't.
- **Don't push and don't publish.** The repository has no remote. Nothing in Tasks 1 to 11 contacts a registry or a git host, except the read-only look-ups named in Task 7.
- **Tests never contain literal secrets.** Build fake secrets at runtime by concatenation.
- **Line endings:** LF.
- **Running tests:**
  - `npm test` runs the Node suite (683 tests at the start of this plan).
  - `npm run test:ui` runs the 45 browser tests.
  - `npm run check:leaks` runs the denylist over the tracked files.
- **Commits:**
  - Use a conventional prefix.
  - End every commit message with a blank line, then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Stage only your files.
- **File-writing tools may turn `\u` escapes into literal invisible characters.** Before committing, scan the changed files for unexpected non-ASCII characters.
- **The repository code supersedes this plan's listings** where they differ. Read the real module before changing it; the listings here show intent and names, not every line.
- **The bar for robustness is normal use.** One or two sessions, Windows, macOS and Linux, a board of up to about 500 tasks. Don't build defences for exotic cases (hand-edited internal files, megabyte inputs, double I/O failures).
- **One combined review per task,** covering spec and quality. Fix what would really break.
- **Scratch copies:** a scratch folder may hold a junction to this repository's `node_modules`. Never run `rm -rf` on a scratch folder; remove a junction with `rmdir` first.
- **If the permission system refuses an action, stop and report it.** Don't work around it.
- **Real Claude Code sessions use up the maintainer's plan limit.** Only the controller starts them, only in Task 9, with the `haiku` model: each scenario once, plus at most one retry per scenario (ten short sessions at the very most). A subagent never starts a model session: no `claude -p`, and no `claude` without a subcommand. `claude plugin validate` and `claude mcp list` make no model call and are allowed.

## Decisions taken in this plan (recorded in the spec by Task 10)

1. **The MCP server is declared in `plugin.json`,** not in a root `.mcp.json`. A root `.mcp.json` is also offered as a project server to anyone who opens this repository in Claude Code, where `${CLAUDE_PLUGIN_ROOT}` is not set and the server fails. This closes plan 1's carry-over.
2. **The marketplace is `.claude-plugin/marketplace.json`** with one plugin whose source is `./` (this repository). Users run `/plugin marketplace add <owner>/<repo>` and `/plugin install agentboard@agentboard`.
3. **No lockfile and no dependencies at the repository root.** Claude Code runs `npm ci --ignore-scripts` in a plugin's folder when it holds both a `package.json` and a lockfile, and that would install Playwright on every user's machine. Playwright and its lockfile move to `test/ui/`. A test keeps the root clean.
4. **The plugin version is the one in `plugin.json`,** kept equal to `package.json` by a test. Users get an update only when it changes.
5. **The leak guard checks three more things:** the packed npm tarball (`--tarball`), what a push would publish (`--push`, in a `pre-push` hook), and, in `--history`, it accepts GitHub's web committer.
6. **A push is refused while commits still carry the local placeholder e-mail** (`@example.invalid`), so the author rewrite of §15 cannot be forgotten.
7. **`"private": true` stays in `package.json`** until Task 12. `npm pack` works with it; only `npm publish` is blocked.
8. **npm publishing is manual** in v1, following `docs/RELEASING.md`. No release workflow.
9. **Acceptance** is `node scripts/acceptance.mjs`: real headless sessions on a temp project, checked through the board's own files. It is run by hand before a release, never in CI.

## File map

```
.claude-plugin/plugin.json        + mcpServers (the MCP server moves here)
.claude-plugin/marketplace.json   new: the marketplace of this repository
.mcp.json                         removed
package.json                      metadata, files, scripts; no devDependencies
package-lock.json                 removed from the root
test/ui/package.json              new: Playwright, development only
test/ui/package-lock.json         new
scripts/lib/denylist.mjs          + readTar(), WEB_COMMITTER_EMAIL, PLACEHOLDER_EMAIL
scripts/check-denylist.mjs        + --tarball <file>, --push <remote>; scissors; web committer
scripts/lib/pack.mjs              new: npmPack()
scripts/check-pack.mjs            new: npm run check:pack
.githooks/pre-push                new
scripts/lib/acceptance.mjs        new: session runner, stream parser, checks
scripts/acceptance.mjs            new: the acceptance run
.github/workflows/ci.yml          rewritten: pinned actions, five jobs
.github/dependabot.yml            new
README.md                         rewritten for users
docs/RELEASING.md                 new: the release checklist
docs/specs/2026-09-29-v1-design.md  §15, §17, §18, §20
test/scripts/*.test.js            leak guard tests
test/plugin.test.js               manifest, marketplace, clean root
test/package.test.js              new: package contents, the packed package runs
test/ci.test.js                   new: workflow rules
test/readme.test.js               new: links, options, requirements
test/scripts/acceptance.test.js   new
test/fixtures/fake-claude.mjs     new: a stand-in for the claude command
```

---

### Task 1: Leak guard: the scissors cleanup mode and GitHub's web committer

Two fixes carried over from plan 1.

**Files:**
- Modify: `scripts/lib/denylist.mjs` (export `WEB_COMMITTER_EMAIL`)
- Modify: `scripts/check-denylist.mjs` (`storedMessage`, `scanHistory`)
- Test: `test/scripts/check-denylist.test.js`

- [ ] **Step 1: Write the failing tests.** Append to `test/scripts/check-denylist.test.js`:

```js
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
```

- [ ] **Step 2: Run them and see the first two fail.**

Run: `node --test test/scripts/check-denylist.test.js`
Expected: the scissors test fails (exit 0 instead of 1) and the web committer test fails (exit 1 instead of 0). The third already passes; it pins the behavior.

- [ ] **Step 3: Implement.**

In `scripts/lib/denylist.mjs`, below `ALLOWED_EMAIL`:

```js
/** The committer of merges and edits made on github.com. Accepted in history as a committer only. */
export const WEB_COMMITTER_EMAIL = 'noreply@github.com';
```

In `scripts/check-denylist.mjs`, `storedMessage` (scissors mode keeps comment lines, like whitespace):

```js
  // verbatim, whitespace and scissors keep comment lines in the stored message.
  if (cleanup === 'verbatim' || cleanup === 'whitespace' || cleanup === 'scissors') return cut;
```

and in `scanHistory`, the committer check:

```js
    if (!ALLOWED_EMAIL.test(committerEmail) && committerEmail !== WEB_COMMITTER_EMAIL) {
      report(`denylist: commit ${short(sha)} committer e-mail is not allowed`);
    }
```

Import `WEB_COMMITTER_EMAIL` in the import list at the top.

- [ ] **Step 4: Run the file again.** Expected: every test passes.
- [ ] **Step 5: Commit** with `fix(guard): scissors cleanup mode and GitHub's web committer`.

---

### Task 2: Leak guard over the packed npm tarball

Spec §15: the private list is checked "on the `npm pack` output".

**Files:**
- Modify: `scripts/lib/denylist.mjs` (`readTar`)
- Modify: `scripts/check-denylist.mjs` (`--tarball <file>`)
- Create: `scripts/lib/pack.mjs` (`npmPack`)
- Create: `scripts/check-pack.mjs`
- Modify: `package.json` (script `check:pack`)
- Test: `test/scripts/lib/denylist.test.js`, `test/scripts/check-denylist.test.js`

- [ ] **Step 1: Write the failing unit tests** in `test/scripts/lib/denylist.test.js` (add `readTar` to the import):

```js
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

test('readTar returns every entry with its path and content', () => {
  const entries = readTar(tarOf([
    { path: 'package/package.json', content: '{}\n' },
    { path: 'cli.js', prefix: 'package/src', content: 'x'.repeat(600) },
    { path: 'PaxHeader', type: 'x', content: '30 path=package/a-long-name.md\n' },
    { path: 'package/empty.txt', content: '' },
  ]));
  assert.deepEqual(entries.map((e) => [e.path, e.type, e.content.length]), [
    ['package/package.json', '0', 3],
    ['package/src/cli.js', '0', 600],
    ['PaxHeader', 'x', 31],
    ['package/empty.txt', '0', 0],
  ]);
  assert.equal(entries[0].content.toString('utf8'), '{}\n');
});

test('readTar refuses what is not a tar archive', () => {
  assert.throws(() => readTar(Buffer.from('not a tar archive, just some text '.repeat(40))), /malformed tar archive/);
  const cut = tarOf([{ path: 'a.txt', content: 'x'.repeat(2000) }]).subarray(0, 1024);
  assert.throws(() => readTar(cut), /malformed tar archive/);
});
```

`tarOf` stays a test helper: copy it into `test/scripts/check-denylist.test.js` for Step 3.

- [ ] **Step 2: Implement `readTar`** in `scripts/lib/denylist.mjs`:

```js
/**
 * The entries of a tar archive (already gunzipped): each header's path and its content, whatever
 * the entry type. Extended headers (pax, GNU long names) come out as entries too, so a long path
 * they carry is scanned as content.
 * @param {Uint8Array} bytes
 * @returns {{ path: string, type: string, content: Buffer }[]}
 */
export function readTar(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = (from, length) => {
    const raw = buf.subarray(from, from + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString('utf8');
  };
  const entries = [];
  let pos = 0;
  while (pos + 512 <= buf.length) {
    if (buf.subarray(pos, pos + 512).every((b) => b === 0)) break; // the end-of-archive blocks
    const size = Number.parseInt(field(pos + 124, 12).trim() || '0', 8);
    if (field(pos + 257, 5) !== 'ustar' || !Number.isInteger(size) || size < 0 || pos + 512 + size > buf.length) {
      throw new Error('malformed tar archive');
    }
    const prefix = field(pos + 345, 155);
    const name = field(pos, 100);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(buf[pos + 156] || 48), // an empty type flag is a regular file
      content: buf.subarray(pos + 512, pos + 512 + size),
    });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
```

Run: `node --test test/scripts/lib/denylist.test.js`. Expected: pass.

- [ ] **Step 3: Write the failing CLI tests** in `test/scripts/check-denylist.test.js` (import `zlib` from `node:zlib`; copy `tarOf` from Step 1):

```js
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
```

Also add `['--tarball']` to the argument lists of the existing test `unknown modes and missing arguments print usage and exit 2`.

- [ ] **Step 4: Implement the mode** in `scripts/check-denylist.mjs`:

```js
import zlib from 'node:zlib';
// ...
const USAGE = 'usage: node scripts/check-denylist.mjs --staged | --all | --history | --message <file> | --tarball <file>';
const MODES = new Map([['--staged', 0], ['--all', 0], ['--history', 0], ['--message', 1], ['--tarball', 1]]);
// ADVICE: '--tarball': 'Remove them from the package.'

/** A packed npm package (.tgz): every entry's path and content. */
function scanTarball(file, terms, report) {
  let entries;
  try {
    entries = readTar(zlib.gunzipSync(fs.readFileSync(file)));
  } catch (err) {
    throw new GuardError(`could not read the package (${err.code || err.name}).`);
  }
  if (entries.length === 0) throw new GuardError('the package is empty.');
  reportFileHits(entries.map((e) => ({ path: e.path, text: decodeText(e.content) })), terms, report);
}
```

In `main`, `--tarball` needs no repository, like `--message`:

```js
  if (mode === '--message') scanMessage(args[0], loadedTerms, report);
  else if (mode === '--tarball') scanTarball(args[0], loadedTerms, report);
  else { /* the git modes, as today */ }
```

Add the mode to the header comment of the file.

- [ ] **Step 5: `npmPack` and `check:pack`.**

`scripts/lib/pack.mjs`:

```js
// Packing the npm package, for the leak guard (scripts/check-pack.mjs) and the package tests.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Runs `npm pack` for the package in `root` and returns the path of the tarball it wrote in `dest`.
 * Under `npm run` and `npm test`, npm's own CLI file is known (npm_execpath) and runs with this
 * Node. Otherwise `npm` is found on PATH through a shell, because it is a .cmd file on Windows.
 * @param {string} root @param {string} dest an existing folder
 */
export function npmPack(root, dest) {
  const args = ['pack', '--json', '--pack-destination', dest];
  const cli = process.env.npm_execpath;
  const r = cli && /npm-cli\.js$/.test(cli)
    ? spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
    : spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { cwd: root, encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error(`npm pack failed (exit ${r.status})`);
  const [{ filename }] = JSON.parse(r.stdout);
  return path.join(dest, filename);
}
```

`scripts/check-pack.mjs`:

```js
#!/usr/bin/env node
// Packs the npm package into a temp folder and runs the leak guard over the tarball
// (npm run check:pack, CI). The tarball is removed afterwards.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmPack } from './lib/pack.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-pack-'));
try {
  const tarball = npmPack(ROOT, dest);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-denylist.mjs'), '--tarball', tarball], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} catch {
  console.error('check-pack: npm pack failed; nothing was approved.');
  process.exitCode = 1;
} finally {
  fs.rmSync(dest, { recursive: true, force: true });
}
```

`package.json` scripts: add `"check:pack": "node scripts/check-pack.mjs"`.

- [ ] **Step 6: Run everything.**

Run: `npm test` (expected: pass), then `npm run check:pack` (expected: exit 0 and no output from the guard), then `node scripts/check-pack.mjs` directly, without npm (expected: exit 0; this takes the shell path).

- [ ] **Step 7: Commit** with `feat(guard): check the packed npm tarball (--tarball, npm run check:pack)`.

---

### Task 3: Leak guard before a push

A `pre-push` hook that checks what the push would publish: the commits the remote does not have yet.

**Files:**
- Modify: `scripts/lib/denylist.mjs` (`PLACEHOLDER_EMAIL`)
- Modify: `scripts/check-denylist.mjs` (`--push <remote>`; `scanHistory` takes the revisions)
- Create: `.githooks/pre-push` (mode 100755)
- Modify: `README.md` (one line in Development: the hook exists)
- Test: `test/scripts/check-denylist.test.js`

**How git calls the hook:** `pre-push <remote name> <url>`, with one line per pushed ref on stdin: `<local ref> <local sha> <remote ref> <remote sha>`. A local sha of all zeros means the remote ref is being deleted.

- [ ] **Step 1: Write the failing tests.** Add this helper and these tests to `test/scripts/check-denylist.test.js`:

```js
/** Adds a bare repository as the remote `origin`, and a publishing identity (the placeholder is refused). */
function withRemote(t) {
  const remote = path.join(t.dir, 'remote.git');
  t.git('init', '-q', '--bare', remote);
  t.git('remote', 'add', 'origin', remote);
  t.git('config', 'user.email', '1+tester@users.noreply.github.com');
  const remoteRefs = () => spawnSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: remote, encoding: 'utf8' }).stdout.trim();
  return { remote, remoteRefs };
}

test('real hooks: pre-push refuses a push that would publish a term, even one a later commit removed', () => {
  const t = tempRepo();
  const { remoteRefs } = withRemote(t);
  t.write('leak.txt', 'first line\nzorbacorp was here\n');
  t.git('add', '.');
  t.git('commit', '-qm', 'add');
  t.git('rm', '-q', 'leak.txt');
  t.git('commit', '-qm', 'remove');
  t.enableHooks();
  const r = t.gitRun(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  assert.notEqual(r.status, 0, 'the push should be refused');
  assert.match(r.stderr, /denylist: history leak\.txt@[0-9a-f]{7}:2 matches entry #1/);
  assert.match(r.stderr, /Rewrite the history before pushing\./);
  assert.equal(remoteRefs(), '');
  assertNoLeak(r);
});

test('real hooks: pre-push checks only what the remote does not have yet, and lets a clean push through', () => {
  const t = tempRepo();
  const { remoteRefs } = withRemote(t);
  t.write('old.txt', 'zorbacorp\n');
  t.git('add', '.');
  t.git('commit', '-qm', 'before the guard');
  t.git('push', '-q', 'origin', 'HEAD:refs/heads/main'); // the hooks are not enabled yet
  t.git('fetch', '-q', 'origin');
  t.enableHooks();
  t.git('rm', '-q', 'old.txt');
  t.write('new.txt', 'clean\n');
  t.git('add', '.');
  t.git('commit', '-qm', 'clean up');
  const r = t.gitRun(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteRefs(), 'refs/heads/main');
  // deleting a remote branch publishes nothing
  t.git('push', '-q', 'origin', 'HEAD:refs/heads/spare');
  assert.equal(t.gitRun(['push', '-q', 'origin', ':refs/heads/spare']).status, 0);
});

test('real hooks: pre-push refuses commits that still carry the local placeholder e-mail', () => {
  const t = tempRepo();
  withRemote(t);
  t.write('a.txt', 'clean\n');
  t.git('add', '.');
  t.git('-c', 'user.email=test@example.invalid', 'commit', '-qm', 'one');
  t.git('-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'two');
  t.enableHooks();
  const r = t.gitRun(['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  assert.notEqual(r.status, 0, 'the push should be refused');
  assert.match(r.stderr, /2 commits still carry the local placeholder e-mail; rewrite the authors before publishing \(docs\/RELEASING\.md\)/);
  assertNoLeak(r, ['test@example.invalid']);
});

test('--push checks the name of the pushed ref and needs a remote name', () => {
  const t = tempRepo();
  withRemote(t);
  t.write('a.txt', 'clean\n');
  t.git('add', '.');
  t.git('commit', '-qm', 'one');
  const sha = t.head();
  const zeros = '0'.repeat(40);
  const push = (input) => spawnSync(process.execPath, [SCRIPT, '--push', 'origin'], { cwd: t.repo, env: t.env, input, encoding: 'utf8' });
  const named = push(`refs/heads/x ${sha} refs/heads/zorbacorp-fix ${zeros}\n`);
  assert.equal(named.status, 1, named.stderr);
  assert.match(named.stderr, /denylist: ref refs\/heads\/\*\*\*-fix matches entry #1/);
  assertNoLeak(named);
  assert.equal(push(`refs/heads/x ${sha} refs/heads/x ${zeros}\n`).status, 0);
  assert.equal(push('').status, 0); // nothing to push
  assert.equal(t.run(['--push']).status, 2);
});
```

`tempRepo()` must also return `env` (the child environment it already builds): add it to the returned object.

- [ ] **Step 2: Run them.** Expected: all four fail (`--push` is unknown: usage and exit 2; the hook file does not exist, so the pushes succeed).

- [ ] **Step 3: Implement.**

In `scripts/lib/denylist.mjs`:

```js
/** The local placeholder identity: allowed in commits, refused in what a push would publish. */
export const PLACEHOLDER_EMAIL = /@example\.invalid$/i;
```

In `scripts/check-denylist.mjs`:
- `MODES`: add `['--push', 1]`; `USAGE`: add `| --push <remote>`; `ADVICE`: `'--push': 'Rewrite the history before pushing.'`; describe the mode in the header comment.
- `scanHistory(root, terms, report, { revs = ['--all'], publishing = false } = {})`:
  - the three git calls take the revisions instead of `--all`, as the last arguments: `['rev-list', '--objects', ...revs]`, `['log', '--root', '-m', '--raw', '--no-renames', '--no-abbrev', '-z', '--format=', '--no-color', ...revs]` and the metadata `log` likewise;
  - the ref-name loop (`for-each-ref`) runs only when `publishing` is false;
  - with `publishing`, count the commits whose author or committer e-mail matches `PLACEHOLDER_EMAIL` and report once: `` `denylist: ${n} commit${n === 1 ? '' : 's'} still carry the local placeholder e-mail; rewrite the authors before publishing (docs/RELEASING.md)` `` (for one commit: "1 commit still carries ...").
- The new mode:

```js
/** What a push would publish (pre-push): for each pushed ref, the commits `remote` does not have yet. */
function scanPush(root, remote, input, terms, report) {
  const tips = [];
  for (const line of input.split('\n')) {
    const [, localSha, remoteRef] = line.trim().split(' ');
    if (!remoteRef) continue;
    for (const h of matchText(remoteRef, terms)) report(`denylist: ref ${remoteRef} matches entry #${h.term}`);
    if (!/^0+$/.test(localSha)) tips.push(localSha); // all zeros: the remote ref is being deleted
  }
  if (tips.length === 0) return;
  // a push to a bare URL has no remote-tracking refs: everything reachable is checked
  const known = git(root, ['remote']).toString('utf8').split(/\r?\n/).includes(remote);
  scanHistory(root, terms, report, { revs: [...tips, ...(known ? ['--not', `--remotes=${remote}`] : [])], publishing: true });
}
```

  In `main`: `else if (mode === '--push') scanPush(root, args[0], fs.readFileSync(0, 'utf8'), loadedTerms, report);`.

`.githooks/pre-push`:

```sh
#!/bin/sh
# Leak guard for what a push would publish: private terms and commit e-mails in the commits
# the remote does not have yet, then secrets in the whole history.
node scripts/check-denylist.mjs --push "$1" || exit 1
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --redact --no-banner . || exit 1
else
  echo "pre-push: gitleaks is not installed; CI will still run it." >&2
fi
```

Make it executable in the index: `git add .githooks/pre-push && git update-index --chmod=+x .githooks/pre-push`, then check with `git ls-files -s .githooks` (every hook is `100755`).

In `README.md`, Development section, after the `core.hooksPath` line, add: "The hooks check every commit and, before a push, everything the push would publish."

- [ ] **Step 4: Run the file, then `npm test`.** Expected: pass. The existing `--history` tests must still pass unchanged.
- [ ] **Step 5: Commit** with `feat(guard): pre-push hook over what a push would publish`.

---

### Task 4: Plugin manifest: the MCP server moves in, and the marketplace

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Delete: `.mcp.json`
- Modify: `package.json` (`files`)
- Modify: `src/core/agents.js` (a comment that names `.mcp.json`)
- Test: `test/plugin.test.js`

- [ ] **Step 1: Read the current docs** for the exact rules, because they change: the plugin manifest reference, the marketplace reference and the page on how plugins are loaded and cached (code.claude.com/docs, "plugins"). Confirm three things and report what you found:
  1. `mcpServers` may be an inline object in `plugin.json`, with `${CLAUDE_PLUGIN_ROOT}` in `args`;
  2. a marketplace entry's `source` may be `"./"` when the marketplace file is in the plugin's own repository;
  3. a package install runs in the plugin's folder only when it holds both a `package.json` and a lockfile (Task 5 depends on this).

- [ ] **Step 2: Update the tests** in `test/plugin.test.js`:

```js
test('plugin manifest', () => {
  const m = json('.claude-plugin/plugin.json');
  assert.equal(m.name, NAME);
  assert.equal(m.version, json('package.json').version);
  assert.equal(m.license, json('package.json').license);
  assert.equal(typeof m.description, 'string');
  assert.deepEqual(fs.readdirSync('.claude-plugin').sort(), ['marketplace.json', 'plugin.json']);
  // hooks and the skill live at their default locations at the plugin root
  for (const key of ['hooks', 'skills', 'commands', 'agents']) assert.equal(m[key], undefined, key);
});

test('MCP server registration', () => {
  // in the manifest, not in a root .mcp.json: that file would also be offered as a project server
  // to anyone who opens this repository in Claude Code, where the plugin root is not set
  assert.deepEqual(json('.claude-plugin/plugin.json').mcpServers, { [NAME]: { command: 'node', args: [ENTRY, 'mcp'] } });
  assert.equal(fs.existsSync('.mcp.json'), false);
});

test('the marketplace of this repository offers the plugin from its root', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, NAME);
  assert.equal(typeof m.owner.name, 'string');
  assert.equal(m.plugins.length, 1);
  const [plugin] = m.plugins;
  assert.equal(plugin.name, NAME);
  assert.equal(plugin.source, './');
  assert.equal(typeof plugin.description, 'string');
  assert.equal(plugin.version, undefined); // plugin.json holds the version
});
```

In `installedPlugin()`, drop `'.mcp.json'` from the copied paths, and in the test `the installed plugin runs from a folder with spaces in its path` read the server from the manifest: `argv(json('.claude-plugin/plugin.json').mcpServers[NAME])`.

Run: `node --test test/plugin.test.js`. Expected: the three tests above fail.

- [ ] **Step 3: Change the files.**

`.claude-plugin/plugin.json`:

```json
{
  "name": "agentboard",
  "version": "0.1.0",
  "description": "A local task board for AI coding agents: create, claim, discuss and hand off tasks across sessions.",
  "author": { "name": "agentboard contributors" },
  "license": "MIT",
  "keywords": ["tasks", "board", "handoff", "agents", "mcp"],
  "mcpServers": {
    "agentboard": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/cli.js", "mcp"]
    }
  }
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "agentboard",
  "owner": { "name": "agentboard contributors" },
  "metadata": { "description": "agentboard: a local task board for AI coding agents." },
  "plugins": [
    {
      "name": "agentboard",
      "source": "./",
      "description": "A local task board for AI coding agents: create, claim, discuss and hand off tasks across sessions."
    }
  ]
}
```

Remove `.mcp.json` with `git rm`. In `package.json`, `files` becomes `["src/", ".claude-plugin/", "hooks/", "skills/"]` (npm always adds `package.json`, `README.md` and `LICENSE`). Fix the comment in `src/core/agents.js` that names `.mcp.json` (it is now "the plugin manifest").

- [ ] **Step 4: Validate with Claude Code itself** (free: no model call).

Run: `claude plugin validate . --strict` and `claude plugin validate .claude-plugin/marketplace.json --strict`.
Expected: both exit 0. If the validator asks for a field or rejects one, follow it, keep the tests in line, and report what changed.

Then, from a fresh temp git repository (not this one): `claude --plugin-dir <this repository> mcp list`.
Expected: the plugin's `agentboard` server is listed. If this version does not list plugin servers there, say so in your report; Task 9's real run checks it.

- [ ] **Step 5: Run `npm test`.** Expected: pass.
- [ ] **Step 6: Commit** with `feat(plugin): MCP server in the manifest, and a marketplace in this repository`.

---

### Task 5: No lockfile at the plugin root: Playwright moves to `test/ui/`

Installing the plugin copies this repository and runs `npm ci --ignore-scripts` in it when it finds a `package.json` with a lockfile. With today's files that would install Playwright on every user's machine. After this task the root has neither dependencies nor a lockfile.

**Files:**
- Create: `test/ui/package.json`, `test/ui/package-lock.json`
- Delete: `package-lock.json` (root)
- Modify: `package.json` (no `devDependencies`; scripts)
- Modify: `test/ui/harness.js` (re-export `chromium`), `scripts/screenshots.mjs` (import it from the harness)
- Modify: `README.md` (Development commands)
- Test: `test/plugin.test.js`

- [ ] **Step 1: Write the failing test** in `test/plugin.test.js`:

```js
test('installing the plugin runs no package install', () => {
  // Claude Code installs packages in a plugin's folder when it holds a package.json and a lockfile
  for (const lock of ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb']) assert.equal(fs.existsSync(lock), false, lock);
  const pkg = json('package.json');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) assert.equal(pkg[key], undefined, key);
  // the browser tests bring their own package, outside the npm package and the plugin's start-up
  assert.deepEqual(Object.keys(json('test/ui/package.json').devDependencies), ['playwright']);
  assert.equal(json('test/ui/package.json').type, 'module');
});
```

Run it. Expected: fail.

- [ ] **Step 2: Create the development package.**

`test/ui/package.json`:

```json
{
  "name": "agentboard-ui-tests",
  "private": true,
  "type": "module",
  "description": "Development only: Playwright for the dashboard's browser tests and screenshots.",
  "devDependencies": {
    "playwright": "^1.63.0"
  }
}
```

`"type": "module"` is required: the nearest `package.json` decides how Node reads the `.js` files of `test/ui/`.

Install the same Playwright version the root has today (1.63.0; confirm it in `node_modules/playwright/package.json`), so the Chromium already downloaded still fits: run `npm --prefix test/ui install --save-dev playwright@1.63.0`. Check that `test/ui/package.json` still says `^1.63.0` and that `test/ui/package-lock.json` exists and resolves Playwright to 1.63.0.

- [ ] **Step 3: Clean the root.**
  - `package.json`: remove `devDependencies`; `"test:ui": "node --test \"test/ui/*.ui.js\""` (no `**`, so nothing under `test/ui/node_modules` is ever picked up); add `"setup:ui": "npm --prefix test/ui ci && npm --prefix test/ui exec -- playwright install chromium"`.
  - `git rm package-lock.json`.
  - Remove the root `node_modules` folder. First make sure it is a real folder of this repository and not a link (`ls -la` shows no `->`; on Windows `fsutil reparsepoint query node_modules` reports that it is not a reparse point). If it is a link, remove the link with `rmdir`, never its target.
  - `test/ui/harness.js`: add `export { chromium };` below the imports. `scripts/screenshots.mjs`: replace `import { chromium } from 'playwright';` with `import { chromium } from '../test/ui/harness.js';`, and update its header comment to `npm run setup:ui`.
  - `README.md`, Development: the browser-test setup line becomes `npm run setup:ui   # once`.

- [ ] **Step 4: Run everything.**

Run: `npm test` (expected: 683 plus the tests added so far, all passing, and the number of test files unchanged: nothing from `test/ui/node_modules` runs), `npm run test:ui` (expected: 45 pass), `npm run screenshots` (expected: the four PNG files in `docs/design/` are byte-identical; `git status` shows no change there), `npm pack --dry-run` (expected: no file under `test/`).

- [ ] **Step 5: Commit** with `build: Playwright moves to test/ui, so the plugin root has no lockfile`.

---

### Task 6: The npm package: metadata, contents and a run from the packed files

**Files:**
- Modify: `package.json`
- Create: `test/package.test.js`

- [ ] **Step 1: Write the tests** in `test/package.test.js`. Read `test/cli.test.js` and `test/plugin.test.js` first and reuse their patterns (`childEnv`, the MCP child, waiting for the dashboard's URL line, killing the child in a `finally`).

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTar } from '../scripts/lib/denylist.mjs';
import { npmPack } from '../scripts/lib/pack.mjs';
import { NAME } from '../src/name.js';
import { gitEnv, tempDir, tempRepo } from './helpers.js';

let unpacked;
/** The real `npm pack` output, unpacked once into a folder with a space in its path. */
function packedPackage() {
  if (unpacked) return unpacked;
  const dest = tempDir();
  const entries = readTar(zlib.gunzipSync(fs.readFileSync(npmPack(path.resolve('.'), dest))));
  const root = path.join(dest, 'Installed Packages');
  for (const e of entries.filter((x) => x.type === '0')) {
    const abs = path.join(root, e.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.content);
  }
  unpacked = { entries, dir: path.join(root, 'package') };
  return unpacked;
}

test('the package ships the runtime files and nothing else', () => {
  const { entries } = packedPackage();
  assert.deepEqual([...new Set(entries.map((e) => e.type))], ['0'], 'only regular files, no extended headers');
  const shipped = entries.map((e) => e.path.replace(/^package\//, '')).sort();
  const tracked = execFileSync('git', ['ls-files', 'src', 'hooks', 'skills', '.claude-plugin', 'LICENSE', 'README.md', 'package.json'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).sort();
  assert.deepEqual(shipped, tracked);
  // the dashboard's fonts ship with their licenses
  assert.ok(shipped.some((p) => /^src\/dashboard\/ui\/fonts\/LICENSE-/.test(p)));
});

test('package metadata', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packedPackage().dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, NAME);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.bin, { [NAME]: 'src/cli.js' });
  assert.ok(pkg.keywords.includes('claude-code'));
  assert.match(fs.readFileSync(path.join(packedPackage().dir, 'src/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});
```

Add two more tests, written with the helpers of `test/cli.test.js`:
- `the packed package runs: help, a hook and the agent tools`: with `cli = path.join(packedPackage().dir, 'src/cli.js')`, `node cli --help` prints the usage line; a `SessionStart` hook call (input and environment as in `test/plugin.test.js`) returns a brief that matches `/you are agent Amber/`; `node cli mcp` answers `tools/list` with 10 tools.
- `the packed package serves the dashboard with its fonts`: start `node cli dashboard --no-open --dir <tempRepo()>`, read the URL from its first output line, then GET `/` (200, HTML), `/app.css` (200) and one font named in `app.css` (200, `font/woff2`); kill the child in a `finally`. Send `Host: 127.0.0.1:<port>` as the other dashboard tests do.

Run: `node --test test/package.test.js`. Expected: `package metadata` fails on `keywords`; the others pass if Tasks 4 and 5 are in.

- [ ] **Step 2: Update `package.json`.** The result, in this key order:

```json
{
  "name": "agentboard",
  "version": "0.1.0",
  "description": "A local task board for AI coding agents, with a read-only live dashboard. A Claude Code plugin and a CLI.",
  "keywords": ["claude-code", "claude-code-plugin", "mcp", "ai-agents", "tasks", "kanban", "board", "handoff"],
  "type": "module",
  "license": "MIT",
  "author": "agentboard contributors",
  "private": true,
  "engines": { "node": ">=22" },
  "bin": { "agentboard": "src/cli.js" },
  "files": ["src/", ".claude-plugin/", "hooks/", "skills/"],
  "scripts": {
    "test": "node --test \"test/**/*.test.js\"",
    "test:ui": "node --test \"test/ui/*.ui.js\"",
    "setup:ui": "npm --prefix test/ui ci && npm --prefix test/ui exec -- playwright install chromium",
    "check:leaks": "node scripts/check-denylist.mjs --all",
    "check:history": "node scripts/check-denylist.mjs --history",
    "check:pack": "node scripts/check-pack.mjs",
    "screenshots": "node scripts/screenshots.mjs"
  }
}
```

`repository`, `homepage` and `bugs` are added in Task 12, when the GitHub account exists. `"private": true` stays until then.

- [ ] **Step 3: Run `npm test` and `npm run check:pack`.** Expected: pass; exit 0.
- [ ] **Step 4: Commit** with `feat(package): npm metadata and tests on the packed package`.

---

### Task 7: CI hardening, and the browser tests on Linux

**Files:**
- Rewrite: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Create: `test/ci.test.js`

This repository has no remote, so the workflow cannot run before the first push. The checks here are a text test and a linter; `docs/RELEASING.md` (Task 10) says to watch the first run.

- [ ] **Step 1: Write the test** `test/ci.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const count = (text) => yml.split(text).length - 1;

test('every action is pinned to a commit, with its version in a comment', () => {
  const uses = [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 7, `${uses.length} actions`);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
    assert.match(rest, /#\s*v\d+\.\d+\.\d+/, ref);
  }
});

test('no job keeps the checkout token, and the workflow can only read', () => {
  assert.equal(count('persist-credentials: false'), count('actions/checkout@'));
  assert.match(yml, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(yml, /pull_request_target/);
});

test('the leak checks: gitleaks is verified by checksum; the denylist covers files, history and the package', () => {
  assert.match(yml, /GITLEAKS_SHA256: [0-9a-f]{64}\b/);
  assert.match(yml, /sha256sum -c/);
  for (const command of ['check-denylist.mjs --all', 'check-denylist.mjs --history', 'npm run check:pack']) assert.ok(yml.includes(command), command);
  assert.ok(count('fetch-depth: 0') >= 2, 'gitleaks and the denylist read the full history');
});

test('the browser tests run on Linux', () => {
  assert.match(yml, /playwright install --with-deps chromium/);
  assert.match(yml, /npm run test:ui/);
});
```

Run it. Expected: fail.

- [ ] **Step 2: Rewrite `.github/workflows/ci.yml`.**

```yaml
name: ci
on:
  push:
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22, 24]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: ${{ matrix.node }}
      - run: git config --global user.email "ci@example.invalid" && git config --global user.name "ci"
      - run: npm test

  ui:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: git config --global user.email "ci@example.invalid" && git config --global user.name "ci"
      - run: npm --prefix test/ui ci
      - run: npm --prefix test/ui exec -- playwright install --with-deps chromium
      - run: npm run test:ui

  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: gitleaks (full history)
        env:
          GITLEAKS_VERSION: 8.30.1
          GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
        run: |
          curl -sSfL -o "$RUNNER_TEMP/gitleaks.tar.gz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum -c -
          tar -xzf "$RUNNER_TEMP/gitleaks.tar.gz" -C "$RUNNER_TEMP" gitleaks
          "$RUNNER_TEMP/gitleaks" git --redact --no-banner .

  denylist:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      AGENTBOARD_DENYLIST: ${{ secrets.AGENTBOARD_DENYLIST }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - name: Is the private list available?
        id: list
        env:
          EVENT: ${{ github.event_name }}
          ACTOR: ${{ github.actor }}
          FORK: ${{ github.event.repository.fork }}
        run: |
          if [ -n "$AGENTBOARD_DENYLIST" ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "present=false" >> "$GITHUB_OUTPUT"
          # forks and Dependabot have no secrets; a push to this repository must have the list
          if [ "$EVENT" = "push" ] && [ "$FORK" != "true" ] && [ "$ACTOR" != "dependabot[bot]" ]; then
            echo "::error::The AGENTBOARD_DENYLIST secret is not set."
            exit 1
          fi
          echo "::notice::No private list here (a fork or Dependabot); the denylist checks were skipped."
      - name: tracked files
        if: ${{ steps.list.outputs.present == 'true' }}
        run: node scripts/check-denylist.mjs --all
      - name: full history
        if: ${{ !cancelled() && steps.list.outputs.present == 'true' }}
        run: node scripts/check-denylist.mjs --history
      - name: the npm package
        if: ${{ !cancelled() && steps.list.outputs.present == 'true' }}
        run: npm run check:pack
```

Before committing, confirm the pins (read-only look-ups, no credentials):
- `git ls-remote --tags https://github.com/actions/checkout v7.0.1` and `git ls-remote --tags https://github.com/actions/setup-node v7.0.0` print the two commits above. If a newer release exists, keep these.
- Read `action.yml` of both actions at those commits (raw.githubusercontent.com) and confirm the inputs used here still exist: `persist-credentials`, `fetch-depth`, `node-version`. If v7 dropped one, fall back to the newest release that has it and update the comment.
- The gitleaks checksum is the `linux_x64` line of `gitleaks_8.30.1_checksums.txt` on the release page.

Notes for the implementer:
- gitleaks and the denylist are separate jobs, so one failing never hides the other.
- The `test` job needs no install: the root has no dependencies.
- `github.event.repository.fork`, the actor and the event go through `env`, never straight into the script.

- [ ] **Step 3: `.github/dependabot.yml`.**

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
  - package-ecosystem: npm
    directory: /test/ui
    schedule:
      interval: monthly
```

- [ ] **Step 4: Lint the workflow.** Download the `actionlint` release binary for this machine into a scratch folder outside the repository (github.com/rhysd/actionlint/releases) and run it on `.github/workflows/ci.yml`. Expected: no findings. If it cannot be downloaded, say so in your report and check the YAML by parsing it with any YAML parser available outside the repository; do not add a dependency.

- [ ] **Step 5: Run `npm test`.** Expected: pass.
- [ ] **Step 6: Commit** with `ci: pinned actions, separate leak jobs, history and package checks, browser tests on Linux`.

---

### Task 8: README for users

**Files:**
- Rewrite: `README.md`
- Create: `test/readme.test.js`

The README is the public face of the project. Write it for a solo developer who uses Claude Code and has never seen this tool. Plain words, short sentences, no marketing. Every example uses the recipes-app data. Every statement must be true today: nothing is published yet, so install instructions use a clone of this repository (Task 12 swaps in the public commands).

- [ ] **Step 1: Write the test** `test/readme.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../src/core/config.js';
import { openBoard } from '../src/core/store.js';
import { buildTools } from '../src/mcp/tools.js';
import { tempRepo } from './helpers.js';

const readme = fs.readFileSync('README.md', 'utf8');

test('every relative link and image of the README points at a file of the repository', () => {
  const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(https?:|#|mailto:)/.test(t));
  assert.ok(targets.length >= 5, `${targets.length} relative links`);
  for (const t of targets) assert.ok(fs.existsSync(path.normalize(t.split('#')[0])), t);
  for (const shot of ['docs/design/overview.png', 'docs/design/board.png', 'docs/design/task.png']) assert.ok(targets.includes(shot), shot);
});

test('the README states the requirements and documents every option and tool', () => {
  assert.match(readme, /Claude Code 2\.1\.139 or newer/);
  assert.match(readme, /Node\.js 22 or newer/);
  for (const option of Object.keys(DEFAULTS)) assert.ok(readme.includes(`\`${option}\``), option);
  for (const tool of buildTools(openBoard(tempRepo()), { folder: '.' })) assert.ok(readme.includes(`\`${tool.name}\``), tool.name);
  for (const flag of ['--port', '--dir', '--no-open']) assert.ok(readme.includes(flag), flag);
});
```

- [ ] **Step 2: Write `README.md`** with these sections, in this order. Read the spec (§1, §2, §5, §7 to §14) and the real code for the facts; the mockup data in `test/fixtures/recipes-app.js` gives the example names.

  1. **Title and one paragraph:** what it is (a local task board for AI coding agents, in the style of a Jira board), who it is for, and the three promises: nothing leaves the machine, no setup step, useful with one agent.
  2. **Status:** pre-release; not published yet.
  3. **Screenshots:** `docs/design/overview.png` first, then `board.png` and `task.png`, each with one line saying what it shows. Mention the dark theme (`overview-dark.png`).
  4. **How it works:** four or five bullets: agents use the board through ten tools; hooks give each session a brief and updates; tasks move through five columns (Backlog, Ready, In progress, Blocked, Done), with Ready and Blocked computed; agent suggestions wait in Backlog for approval; file locks turn on by themselves when two agents are live.
  5. **Requirements:** Claude Code 2.1.139 or newer (the hooks use the exec form); Node.js 22 or newer on PATH; git (the board lives inside the git directory).
  6. **Install:** from a clone, today: `claude plugin marketplace add ./agentboard` then `claude plugin install agentboard@agentboard`; or for one session `claude --plugin-dir ./agentboard`. One sentence: installing copies the repository and installs no packages.
  7. **First use:** no init. Start Claude Code in a project and say things like "create a task to add a pancake recipe", "what's ready?", "open the board". Include the table of phrases from `skills/agentboard/SKILL.md` in a shorter form (six to eight rows).
  8. **The dashboard:** how to open it ("open the board", or `node ./agentboard/src/cli.js dashboard [--port N] [--dir PATH] [--no-open]` from a clone); it is read-only and live; the four views (Overview, Board, Activity, task) in one line each; it listens on 127.0.0.1 only; one opened by an agent stops 30 minutes after its last tab closes, one started in a terminal runs until Ctrl+C.
  9. **What agents can do:** a table of the ten tools, one line each (names in backticks).
  10. **Configuration:** `.agentboard/config.json` with every option, its default and its range (from `src/core/config.js`), and `.agentboard/rules.md`.
  11. **Where the data lives:** inside the git directory (`.git/agentboard/`), shared by all worktrees, never committed; outside git, in `.agentboard/` data folders as the spec says (check §6). `agentboard repair` rebuilds the snapshots from the event log.
  12. **Privacy and safety:** no network, no telemetry; likely secrets are redacted before they are stored; board text is treated as data, never as instructions; the dashboard answers GET only and checks the Host header.
  13. **Development:** keep today's content, updated: `npm test`, `git config core.hooksPath .githooks`, `npm run setup:ui`, `npm run test:ui`, the leak guard paragraph, `npm run check:pack`, `npm run check:history`, and a pointer to `docs/RELEASING.md` (created by Task 10; link it only if the file exists when you commit, otherwise name it without a link and tell the controller).
  14. **License:** MIT.

- [ ] **Step 3: Run `node --test test/readme.test.js` and `npm test`.** Expected: pass. Then `npm run check:pack` (the README ships in the package). Expected: exit 0.
- [ ] **Step 4: Commit** with `docs: README for users, with the dashboard and screenshots`.

---

### Task 9: The acceptance script

Spec §17: acceptance happens on a throwaway toy project, scripted: (1) one agent creates, works on and completes tasks across two sessions; (2) two agents work in parallel with a dependency, a question to the human and a lock conflict.

**Files:**
- Create: `scripts/lib/acceptance.mjs`, `scripts/acceptance.mjs`
- Create: `test/fixtures/fake-claude.mjs`
- Test: `test/scripts/acceptance.test.js`

**Usage rule:** real sessions draw on the maintainer's plan limit. The implementer never starts a real `claude` session: everything in Steps 1 to 5 runs against `test/fixtures/fake-claude.mjs`. Steps 6 and 7 belong to the controller. The script itself refuses to start more than five sessions in one run (a counter in the runner, checked before every start), and every session has a 5-minute limit.

**How a session is started** (from the execution notes of plans 1 and 2):

```
claude -p --model haiku --plugin-dir <this repository>
  --setting-sources project,local
  --strict-mcp-config --mcp-config <file>
  --permission-mode acceptEdits
  --allowedTools "mcp__agentboard__*" Read Edit Write Glob Grep TodoWrite
  --disallowedTools Bash PowerShell
  --output-format stream-json --verbose
  --max-budget-usd <budget> --no-session-persistence
```

- The prompt goes through stdin, never through the command line (on Windows `claude` is a `.cmd` file and must run through a shell; only flags and quoted paths are on the command line).
- `--setting-sources project,local` keeps the maintainer's own settings, hooks and plugins out. `--strict-mcp-config` keeps the account's connectors out, and also drops the plugin's own server, so `<file>` declares it again: `{ "mcpServers": { "agentboard": { "command": "node", "args": ["<this repository>/src/cli.js", "mcp"] } } }`. The tools are then named `mcp__agentboard__*`.
- The child environment drops `CLAUDECODE` and every `CLAUDE_*` variable except `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*`, so a session started from inside another Claude Code session has its own identity.
- A session that must stay alive while another one runs (the lock needs two live agents) is started with `--input-format stream-json`: each user turn is one JSON line on stdin, `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`, a turn ends at the `{"type":"result",...}` line on stdout, and the session ends when stdin closes.

- [ ] **Step 1: Write the library's tests** in `test/scripts/acceptance.test.js`, with `test/fixtures/fake-claude.mjs`.

The fake is a Node script run as `node fake-claude.mjs <flags>`. It reads its script from the `FAKE_CLAUDE_SCRIPT` environment variable (a JSON array with, per turn, the stream-json lines to print), prints a `{"type":"system","subtype":"init","session_id":"..."}` line first, and then, for each prompt it reads (the whole of stdin in text mode, one JSON line per turn with `--input-format stream-json`), prints that turn's lines and a `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"result":"done"}` line. It writes the prompts and its arguments to the file named by `FAKE_CLAUDE_LOG`, so tests can assert them.

Tests to write (names are the contract):
- `claudeArgs builds the flags of a headless session`: the list above, with `--input-format stream-json` only for a held session; no prompt among the arguments.
- `childEnv drops the session variables of a surrounding Claude Code session and keeps the account's`.
- `runSession sends the prompt on stdin and returns the turn: text, tool calls with their results, cost`: the fake prints an assistant message with a `tool_use` block and a user message with its `tool_result`; the returned turn has `{ text, cost, tools: [{ name, input, output, isError }] }`.
- `a held session takes several turns and ends when it is closed`: `const s = await openSession(...)`, `await s.send('one')`, `await s.send('two')`, `await s.close()`; the fake's log shows both prompts in one process.
- `a turn that ends in an error, or a session that exits early, is reported with the turn's last text`.
- `a session that does not answer within the time limit is killed`.
- `checkSolo passes on the board a good run leaves, and names what is missing otherwise` and the same for `checkPair`: build the boards with the real operations, the way `test/fixtures/recipes-app.js` does, in a `tempRepo()`.

- [ ] **Step 2: Implement `scripts/lib/acceptance.mjs`.** Exports:

```js
/** @typedef {{ name: string, input: any, output: string, isError: boolean }} ToolCall */
/** @typedef {{ text: string, cost: number, tools: ToolCall[] }} Turn */
/** @typedef {{ name: string, ok: boolean, detail: string }} Check */

export function claudeArgs({ pluginDir, mcpConfig, model, budgetUsd, held }) { /* string[] */ }
export function childEnv(env = process.env) { /* Record<string, string> */ }
/** One-shot session: resolves its single turn. `command` replaces `claude` in tests. */
export async function runSession({ cwd, prompt, command, timeoutMs, ...flags }) { /* Promise<Turn> */ }
/** A session kept alive: { send(prompt): Promise<Turn>, close(): Promise<void> }. */
export async function openSession({ cwd, command, timeoutMs, ...flags }) {}
/** @returns {Check[]} */
export function checkSolo({ board, turns, files }) {}
/** @returns {Check[]} */
export function checkPair({ board, turns, files }) {}
```

`board` is what `openBoard(project)` returns; the checks read it with `readState`, `readRegistry`, `readMessages` and the event log (`board.files`), all from `src/core/store.js`. `files` maps a project file name to its text. `turns` maps a session label to its turns.

**`checkSolo`** (one agent, two sessions):
1. tasks #1 and #2 exist, were requested by the human, and are Done with a summary;
2. #2 was claimed in the first session and completed by a different session (another agent id), with no release in between: the claim was inherited;
3. #2 has a checklist of at least two items, all done;
4. each task lists at least one touched file, and those files exist with the expected words (`pancake` in `recipes.md`);
5. the board logged no internal error (no `errors.log`) and no malformed line (`logHealth`).

**`checkPair`** (two agents in parallel):
1. #2 depends on #1;
2. the second agent's claim of #2 was refused while #1 was open: its first turn has a `claim_task` call whose output says `#2 waits on #1`;
3. the second agent's edit of `recipes.md` was refused, and the refusal names the first agent (the name comes from the registry, not from a constant): an `Edit` or `Write` call with `isError` and that name in the output; and the refused line is not in `recipes.md`;
4. #1 has a question to the human and an answer to it marked as relayed from the human;
5. #1 is Done by the first agent; #2 was claimed after #1 was completed (event order) and is Done by another agent;
6. no internal error, no malformed line.

Each failed check's `detail` says what was found instead, in one line.

- [ ] **Step 3: Run the tests.** Run: `node --test test/scripts/acceptance.test.js`. Expected: pass.

- [ ] **Step 4: Implement `scripts/acceptance.mjs`.**

```
usage: node scripts/acceptance.mjs [solo|pair|all] [--model haiku] [--budget 0.40] [--keep]
```

- It makes `<temp>/agentboard-acceptance-XXXXXX/recipes-app`: `git init`, a placeholder identity in the repository's own config (`recipes@example.invalid`), and one commit with `README.md` ("# recipes-app") and `recipes.md` ("# Recipes"). The MCP config file goes next to the project, not in it.
- **solo** (`all` uses a fresh project for each scenario):
  - session 1: "Create two tasks on the board for me: 'Add a pancake recipe to recipes.md' and 'Add a table of contents to README.md'. Claim the first, do it, and complete it. Then claim the second, set a checklist with exactly two steps, do only the first step and mark it done. Then stop: do not complete or release the second task; the next session continues it."
  - session 2 (a new process in the same folder): "Continue the task the board gave you and complete it."
- **pair:**
  - session A, held open: "Create two tasks on the board for me: 'Add an ingredients section to recipes.md' and 'Write shopping.md from the ingredients', where the second depends on the first. Claim the first. Add the heading '## Ingredients' to recipes.md. Then ask me on the task whether to use metric or imperial units, and stop there."
  - session B, one shot, while A is open: "Claim task #2. Then append the line 'Tip: taste as you go.' to recipes.md. If the board or a tool refuses something, do not work around it and do not retry: tell me exactly what it said."
  - session A, second turn: "My answer to your question: metric. Record my answer on the board, add two ingredients in metric units under the heading, and complete the task."
  - session C, one shot: "Claim task #2, write shopping.md with the ingredients from recipes.md, and complete the task." Then close A.
- It prints one line per check (`ok` or `FAILED` with the detail), the cost of each session and the total, and exits 1 when any check failed. The temp folder is removed at the end, unless `--keep` is given or a check failed; then its path is printed, so the transcripts (saved as `<label>.jsonl` next to the project) can be read.
- Each session has a 5-minute limit. `--budget` is the limit per session.

Add one line to the README's Development section: what the script is, that it starts real sessions on the maintainer's account, and how to run it.

- [ ] **Step 5: Run `npm test`, then commit** with `test: scripted acceptance on a throwaway project (scripts/acceptance.mjs)`.

- [ ] **Step 6 (controller): one real run.** Run `node scripts/acceptance.mjs solo --keep`, read the output and the transcripts, then `node scripts/acceptance.mjs pair --keep`. Each scenario runs once; one retry per scenario at most, and only after reading the transcript and changing something. When a check fails, decide from the transcript whether the product, the prompt or the check is wrong:
  - a product fault becomes a fix in its own commit, with a test;
  - a prompt that a small model misreads is reworded;
  - a check that is stricter than the spec is relaxed.
  Also confirm, in the `init` line of one transcript, that the plugin's hooks ran and the `agentboard` server was connected with ten tools.
  Remove the kept temp folders afterwards.

- [ ] **Step 7 (controller): record the result** in this plan's execution notes: the date, the model, the checks that passed, the total cost and anything that had to change.

---

### Task 10: The release guide and the spec (controller)

The controller does this task directly.

**Files:**
- Create: `docs/RELEASING.md`
- Modify: `docs/specs/2026-09-29-v1-design.md` (§15, §17, §18, §20)
- Modify: `README.md` (link to the guide, if Task 8 could not link it)

- [ ] **Step 1: Write `docs/RELEASING.md`.** A checklist a maintainer follows by hand, in this order. It is public: no names, accounts or paths of any real person.

  1. **Before anything is pushed**
     - Choose the final name. Rename: `src/name.js`; `package.json` (`name`, `bin`); `.claude-plugin/plugin.json` and `marketplace.json`; the skill folder and its front matter; the server key in the manifest; `hooks/hooks.json` (description); the `AGENTBOARD_*` variables of the leak guard and CI; tests and docs. Find every place with `git grep -i agentboard`. Run all the checks.
     - Create the GitHub account that publishes the project. In its settings, turn on "Keep my email addresses private" and "Block command line pushes that expose my email".
     - Set this repository's identity to that account's no-reply address (`git config user.name`, `git config user.email`), and rewrite every commit's author and committer to it. Check that nothing else is left: `git log --all --format='%ae %ce' | sort -u` prints one address.
     - Run `npm test`, `npm run test:ui`, `npm run check:leaks`, `npm run check:history`, `npm run check:pack`, and `node scripts/acceptance.mjs`.
  2. **The first push**
     - Create the repository as private. Turn on secret scanning and push protection. Add the `AGENTBOARD_DENYLIST` secret (the private list, one term per line).
     - Add the remote with credentials of the new account only (an SSH key made for it, selected with `core.sshCommand`, or a credential helper that holds nothing else). Never push with another account's cached login.
     - `git config core.hooksPath .githooks`, so the `pre-push` hook runs. Push. The hook refuses the push while a commit still carries the placeholder e-mail.
     - Watch the first CI run. It is the first time the workflow runs at all, and the first time the browser tests run on Linux.
  3. **Try the plugin from the marketplace** in a throwaway project: `/plugin marketplace add <owner>/<repo>`, `/plugin install <name>@<name>`, then "what does the board say?" and "open the board". Check that installing ran no package install (the plugin's cache folder has no `node_modules`).
  4. **Going public**
     - Run `npm run check:history` and gitleaks over the full history once more, and review the repository as a stranger would.
     - Make the repository public.
  5. **npm**
     - Add `repository`, `homepage` and `bugs` to `package.json`; remove `"private": true`.
     - `npm run check:pack`, `npm pack --dry-run` (read the file list), then `npm publish`.
     - In a throwaway project: `npx <name> dashboard`.
     - Update the README: the install commands with `<owner>/<repo>`, `npx <name> dashboard`, and the status line.
  6. **Every later release**
     - Bump `version` in `package.json` and `.claude-plugin/plugin.json` together (a test keeps them equal). Users of the plugin get an update only when the version changes.
     - Run the checks of step 1, tag, push, publish.

- [ ] **Step 2: Update the spec.**
  - §15: the private list is checked "on every commit, before every push (over what the push would publish), and on the `npm pack` output"; a push is refused while commits carry the placeholder e-mail; GitHub's web committer is accepted in history.
  - §17: "CI runs the Node tests on Windows, macOS and Linux, and the browser tests on Linux"; acceptance is `node scripts/acceptance.mjs`, run by hand before a release.
  - §18: the marketplace file is `.claude-plugin/marketplace.json` and its plugin is this repository; the MCP server is declared in the plugin manifest; installing the plugin installs no packages (the repository root has no dependencies and no lockfile); the npm package ships the runtime files only.
  - §20: add a row: "Where development dependencies live | Decided in plan 3: in `test/ui/`, so the plugin root has no lockfile".

- [ ] **Step 3: Run `npm test` and `npm run check:leaks`, scan for non-ASCII, commit** with `docs: release guide; spec records plan 3's decisions`.

---

### Task 11: Final review of plan 3 (controller)

- [ ] **Step 1:** Run `npm test`, `npm run test:ui`, `npm run check:leaks`, `npm run check:history`, `npm run check:pack`, `claude plugin validate . --strict`.
- [ ] **Step 2:** Dispatch one reviewer over the whole branch (`git diff main...HEAD`), with the bar of the ground rules: what would break in real use, leaks, and anything a user would hit on install. It reads; it does not commit.
- [ ] **Step 3:** Fix what would really break, record the rest in one line each in the execution notes, and update the project memory.
- [ ] **Step 4:** Ask the maintainer before merging into `main`, and for the decisions of Task 12.

---

### Task 12: Release (waits for the maintainer)

Not started by a subagent, and not before the maintainer gives:
- the final name of the tool;
- the new GitHub account (and the npm account) that publishes it.

Then follow `docs/RELEASING.md` step by step, asking before each push and before `npm publish`.

---

## Self-review against the scope

| Scope item | Where |
|---|---|
| npm packaging | Tasks 2, 5, 6; publishing itself in Task 12 |
| Plugin marketplace (§18) | Task 4; tried from GitHub in `docs/RELEASING.md` step 3 |
| CI hardening: gitleaks checksum, denylist in its own job, pinned actions, `persist-credentials: false`, `setup-node` in the leak job, forks and Dependabot, denylist runs even if gitleaks fails | Task 7 |
| `test:ui` in CI on Linux | Tasks 5 and 7 |
| `--history` in CI; a `pre-push` hook over the pushed range | Tasks 3 and 7 |
| Denylist over the packed tarball; CI inspects the tarball (§15) | Tasks 2, 6 and 7 |
| Leak guard: `commit.cleanup=scissors`; `noreply@github.com` as committer | Task 1 |
| README: dashboard usage and screenshots; requirements (Claude Code 2.1.139, Node.js 22) | Task 8 |
| Acceptance script on a throwaway project (§17), with `--strict-mcp-config` and `--mcp-config` | Task 9 |
| Root `.mcp.json` fails when this repository is opened in Claude Code | Task 4 |
| The skill maps "open the board" | Done in plan 2 (Task 8 there); the README repeats it |
| Full-history scan right before going public; commit identity (§15); going public | `docs/RELEASING.md` (Task 10), executed in Task 12 |
| Remove `"private": true` before publishing | Task 12, through `docs/RELEASING.md` step 5 |
| Final name and publishing account (§20) | Task 12 |

## Execution notes

(Filled in as the tasks are done.)
