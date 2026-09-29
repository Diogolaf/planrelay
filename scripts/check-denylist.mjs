#!/usr/bin/env node
// Leak guard: blocks private terms from entering the repository.
// Terms come from AGENTBOARD_DENYLIST (CI secret) or a private file outside the repo
// (AGENTBOARD_DENYLIST_FILE, default ~/.agentboard-dev/denylist.txt).
// Matches are reported by entry number, and every printed line goes through maskTerms,
// so a private term never reaches a terminal or a CI log. File content is never printed.
//
// Modes:
//   --staged          the index (pre-commit, pre-merge-commit) plus the commit identity
//   --all             tracked files in the working tree (npm run check:leaks, CI)
//   --history         every blob, path, commit, annotated tag and ref name reachable from all refs,
//                     plus the commit and tagger e-mails (refused in a shallow clone)
//   --message <file>  the part of a commit message git will store (commit-msg)
//
// Fails closed: any git or IO error aborts the scan with exit code 1.
// This file always runs main (importing it runs the scan); the pure logic lives in
// scripts/lib/denylist.mjs, which is what the unit tests import.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_EMAIL,
  cutAtScissors,
  decodeText,
  findMatches,
  maskTerms,
  matchText,
  parseCatFileBatch,
  parseRawDiff,
  parseRevListObjects,
  parseTerms,
  splitIdent,
} from './lib/denylist.mjs';

const MAX_BUFFER = 512 * 1024 * 1024;
const GITLINK = '160000'; // a submodule entry: the object is a commit in another repository
const USAGE = 'usage: node scripts/check-denylist.mjs --staged | --all | --history | --message <file>';
/** Mode -> number of arguments it takes. */
const MODES = new Map([['--staged', 0], ['--all', 0], ['--history', 0], ['--message', 1]]);
const ADVICE = {
  '--staged': 'Remove them before committing.',
  '--all': 'Remove them from the repository.',
  '--history': 'Rewrite the history before publishing.',
  '--message': 'Edit the commit message.',
};

/** An error whose message is safe to print (it still goes through maskTerms). */
class GuardError extends Error {}

/** The terms in use; say() masks every line with them. */
let loadedTerms = [];

/** Prints one line to stderr with private terms masked and control characters neutralized. */
function say(line) {
  console.error(maskTerms(line, loadedTerms).replace(/\p{Cc}/gu, '?'));
}

function loadTerms(env = process.env) {
  if (env.AGENTBOARD_DENYLIST) return parseList(env.AGENTBOARD_DENYLIST);
  const file = env.AGENTBOARD_DENYLIST_FILE || path.join(os.homedir(), '.agentboard-dev', 'denylist.txt');
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new GuardError('no denylist found. Create ~/.agentboard-dev/denylist.txt (one term per line) or set AGENTBOARD_DENYLIST.');
    }
    throw new GuardError(`could not read the denylist (${err.code || err.name}).`);
  }
  return parseList(bytes);
}

/** parseTerms' error messages carry line numbers only, so they are safe to print. */
function parseList(input) {
  try {
    return parseTerms(input);
  } catch (err) {
    throw new GuardError(err.message);
  }
}

/**
 * Runs git and returns stdout as a Buffer. git's stderr is captured and dropped:
 * it can contain paths or identities. Any failure aborts the scan.
 */
function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: MAX_BUFFER, windowsHide: true });
  if (r.error) {
    const why = r.error.code === 'ENOBUFS' ? 'output larger than 512 MB' : r.error.code || r.error.name;
    throw new GuardError(`git ${args[0]} failed (${why}); scan aborted.`);
  }
  if (r.status !== 0) throw new GuardError(`git ${args[0]} failed (${r.signal || `exit ${r.status}`}); scan aborted.`);
  return r.stdout;
}

const splitNul = (buf) => buf.toString('utf8').split('\0').filter(Boolean);
const short = (sha) => sha.slice(0, 7);

/** Reads objects through one `git cat-file --batch` process. Missing objects abort the scan. */
function readObjects(root, shas, type) {
  const wanted = [...new Set(shas)];
  const found = new Map();
  if (wanted.length === 0) return found;
  let objects;
  try {
    objects = parseCatFileBatch(git(root, ['cat-file', '--batch'], `${wanted.join('\n')}\n`));
  } catch (err) {
    if (err instanceof GuardError) throw err;
    throw new GuardError('unexpected git cat-file output; scan aborted.');
  }
  for (const obj of objects) {
    if (obj.missing || obj.type !== type) throw new GuardError(`git cat-file could not read ${type} ${short(obj.sha)}; scan aborted.`);
    found.set(obj.sha, obj.content);
  }
  for (const sha of wanted) {
    if (!found.has(sha)) throw new GuardError(`git cat-file could not read ${type} ${short(sha)}; scan aborted.`);
  }
  return found;
}

/** Both identities of the commit being made: allowed e-mail, no private term. Never prints them. */
function checkIdentity(root, terms, report) {
  for (const [who, variable] of [['author', 'GIT_AUTHOR_IDENT'], ['committer', 'GIT_COMMITTER_IDENT']]) {
    let ident;
    try {
      // git var reflects --author, -c user.*/author.*/committer.* and GIT_AUTHOR_*/GIT_COMMITTER_*.
      ident = git(root, ['var', variable]).toString('utf8').trim();
    } catch {
      report(`check-denylist: the ${who} identity is not configured.`);
      continue;
    }
    const parts = splitIdent(ident);
    if (!parts) {
      report(`check-denylist: the ${who} identity could not be parsed.`);
      continue;
    }
    const { name, email } = parts;
    if (!ALLOWED_EMAIL.test(email)) {
      report(`check-denylist: the ${who} e-mail is not allowed; use a GitHub no-reply address or an @example.invalid placeholder.`);
    }
    for (const h of matchText(`${name} <${email}>`, terms)) report(`denylist: ${who} name or e-mail matches entry #${h.term}`);
  }
}

function reportFileHits(files, terms, report) {
  for (const h of findMatches(files, terms)) {
    report(`denylist: ${h.path}:${h.line === 0 ? '(path)' : h.line} matches entry #${h.term}`);
  }
}

/** The index as it will be committed: added, copied, modified, renamed and type-changed entries. */
function scanStaged(root, terms, report) {
  checkIdentity(root, terms, report);
  const entries = parseRawDiff(
    git(root, ['diff', '--cached', '--raw', '-z', '--diff-filter=d', '--no-renames', '--no-abbrev', '--no-relative', '--no-color']),
  );
  const blobs = readObjects(root, entries.filter((e) => e.dstMode !== GITLINK).map((e) => e.dstSha), 'blob');
  const files = entries.map((e) => ({
    path: e.path,
    // A submodule commit is not ours to read; its path still is. A symlink blob is its link text.
    text: e.dstMode === GITLINK ? '' : decodeText(blobs.get(e.dstSha)),
  }));
  reportFileHits(files, terms, report);
}

/** Tracked files as they are in the working tree. */
function scanAll(root, terms, report) {
  const names = [...new Set(splitNul(git(root, ['ls-files', '-z'])))];
  for (const name of names) {
    const abs = path.join(root, name);
    let text = '';
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) text = fs.readlinkSync(abs); // scanned as its link text, never followed
      else if (st.isFile()) text = decodeText(fs.readFileSync(abs));
      // anything else (a submodule directory): only the path is ours
    } catch (err) {
      // Deleted in the working tree: the path is still scanned; the staged scan covers commits.
      if (err.code !== 'ENOENT') {
        report(`denylist: could not read ${name} (${err.code || err.name})`);
        continue;
      }
    }
    reportFileHits([{ path: name, text }], terms, report);
  }
}

/** Everything reachable from any ref: what a push would publish. */
function scanHistory(root, terms, report) {
  // A shallow clone lacks the older commits, so a clean result would be meaningless.
  if (git(root, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim() !== 'false') {
    throw new GuardError('this is a shallow clone, so older history cannot be checked; run `git fetch --unshallow` first.');
  }

  // Every object reachable from all refs, with the first path git gives it.
  const listed = parseRevListObjects(git(root, ['rev-list', '--all', '--objects']));
  const shas = [...new Set(listed.map((o) => o.sha))];
  const types = new Map();
  if (shas.length) {
    for (const line of git(root, ['cat-file', '--batch-check'], `${shas.join('\n')}\n`).toString('utf8').split('\n')) {
      const m = /^([0-9a-f]{40,64}) (\S+) \d+$/.exec(line);
      if (m) types.set(m[1], m[2]);
    }
  }
  for (const sha of shas) {
    if (!types.has(sha)) throw new GuardError(`git cat-file could not read object ${short(sha)}; scan aborted.`);
  }

  // Every (path, blob) pair of every commit. rev-list names each object once, so a path
  // whose content also lives elsewhere (an empty file, say) only shows up here.
  const pairs = parseRawDiff(
    git(root, ['log', '--all', '--root', '-m', '--raw', '--no-renames', '--no-abbrev', '-z', '--format=', '--no-color']),
  );
  const pathOf = new Map(); // blob -> a path, for the report
  const paths = new Map(); // path -> an object, for the report
  for (const { sha, path: p } of listed) {
    const type = types.get(sha);
    if (!p || (type !== 'blob' && type !== 'tree')) continue;
    if (!pathOf.has(sha)) pathOf.set(sha, p);
    if (!paths.has(p)) paths.set(p, sha);
  }
  for (const e of pairs) {
    if (!pathOf.has(e.dstSha)) pathOf.set(e.dstSha, e.path);
    if (!paths.has(e.path)) paths.set(e.path, e.dstSha);
  }

  for (const [p, sha] of paths) {
    for (const h of matchText(p, terms)) report(`denylist: history ${p}@${short(sha)}:(path) matches entry #${h.term}`);
  }
  const blobShas = shas.filter((s) => types.get(s) === 'blob');
  for (const [sha, content] of readObjects(root, blobShas, 'blob')) {
    const where = `${pathOf.get(sha) || '(no path)'}@${short(sha)}`;
    for (const h of matchText(decodeText(content), terms)) report(`denylist: history ${where}:${h.line} matches entry #${h.term}`);
  }

  // Commit metadata: author and committer names and e-mails, full messages (raw, no mailmap).
  // Both e-mails must also be allowed addresses, as the pre-commit identity check demands.
  const log = git(root, [
    'log', '--all', '-z', '--no-show-signature', '--no-use-mailmap', '--encoding=UTF-8', '--no-color',
    '--format=%H%n%an%n%ae%n%cn%n%ce%n%B',
  ]).toString('utf8');
  for (const record of log.split('\0')) {
    const lines = record.replace(/^\n+/, '').split('\n');
    if (lines.length < 5) continue;
    const [sha, , authorEmail, , committerEmail] = lines;
    if (!ALLOWED_EMAIL.test(authorEmail)) report(`denylist: commit ${short(sha)} author e-mail is not allowed`);
    if (!ALLOWED_EMAIL.test(committerEmail)) report(`denylist: commit ${short(sha)} committer e-mail is not allowed`);
    const found = new Set(matchText(lines.slice(1).join('\n'), terms).map((h) => h.term));
    for (const k of found) report(`denylist: commit ${short(sha)} metadata matches entry #${k}`);
  }

  // Annotated tags (name, tagger, message) and ref names are published by a push too.
  const tagShas = shas.filter((s) => types.get(s) === 'tag');
  for (const [sha, content] of readObjects(root, tagShas, 'tag')) {
    const text = decodeText(content);
    const header = text.split('\n\n')[0].split('\n');
    const name = header.find((l) => l.startsWith('tag '))?.slice(4) || short(sha);
    const tagger = header.find((l) => l.startsWith('tagger '));
    if (tagger && !ALLOWED_EMAIL.test(splitIdent(tagger.slice(7))?.email ?? '')) {
      report(`denylist: tag ${name} tagger e-mail is not allowed`);
    }
    const found = new Set(matchText(text, terms).map((h) => h.term));
    for (const k of found) report(`denylist: tag ${name} metadata matches entry #${k}`);
  }
  for (const ref of git(root, ['for-each-ref', '--format=%(refname)']).toString('utf8').split('\n').filter(Boolean)) {
    for (const h of matchText(ref, terms)) report(`denylist: ref ${ref} matches entry #${h.term}`);
  }
}

/**
 * The part of a commit message file that git will store. The commit-msg hook receives the
 * file before git cleans it up, so an editor commit still holds git's template: comment
 * lines (branch, status, file names, even of files being deleted) and, with -v, the diff
 * below the scissors line. Scanning those would block a commit that removes a leak.
 */
function storedMessage(text) {
  // Git sets GIT_EDITOR=: for the hook when no editor runs (-m, -F, --no-edit). There is no
  // template then, and git keeps comment lines by default, so everything is scanned.
  if (process.env.GIT_EDITOR === ':') return text;
  const cut = cutAtScissors(text);
  const cleanup = git(process.cwd(), ['config', '--default', 'default', 'commit.cleanup']).toString('utf8').trim();
  // verbatim and whitespace keep comment lines in the stored message.
  if (cleanup === 'verbatim' || cleanup === 'whitespace') return cut;
  // git stripspace honours core.commentChar, as git commit does.
  return git(process.cwd(), ['stripspace', '--strip-comments'], cut).toString('utf8');
}

/** A commit message file (commit-msg hook): only what git will store is scanned. */
function scanMessage(file, terms, report) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new GuardError(`could not read the commit message file (${err.code || err.name}).`);
  }
  for (const h of matchText(storedMessage(decodeText(bytes)), terms)) {
    report(`denylist: commit message:${h.line} matches entry #${h.term}`);
  }
}

function main(argv) {
  const [mode, ...args] = argv;
  if (!MODES.has(mode) || args.length !== MODES.get(mode) || args.some((a) => a === '')) {
    console.error(USAGE);
    return 2;
  }
  loadedTerms = loadTerms();
  if (loadedTerms.length === 0) throw new GuardError('the denylist has no entries.');

  const findings = new Set(); // one line per finding, deduplicated, printed at the end
  const report = (line) => findings.add(line);
  if (mode === '--message') {
    scanMessage(args[0], loadedTerms, report);
  } else {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\r?\n$/, '');
    if (mode === '--staged') scanStaged(root, loadedTerms, report);
    else if (mode === '--all') scanAll(root, loadedTerms, report);
    else scanHistory(root, loadedTerms, report);
  }

  for (const line of findings) say(line);
  if (findings.size) {
    say(`check-denylist: ${findings.size} problem(s) found. ${ADVICE[mode]}`);
    return 1;
  }
  return 0;
}

/** Fails closed with one clean line: never a stack or a raw error message (they can carry content). */
function run(argv) {
  try {
    return main(argv);
  } catch (err) {
    if (err instanceof GuardError) say(`check-denylist: ${err.message}`);
    else say(`check-denylist: unexpected error (${err?.code || err?.name || 'unknown'}); nothing was approved.`);
    return 1;
  }
}

process.exitCode = run(process.argv.slice(2));
