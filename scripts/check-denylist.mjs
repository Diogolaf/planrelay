#!/usr/bin/env node
// Blocks private terms from entering the repository.
// Terms come from AGENTBOARD_DENYLIST (CI secret) or ~/.agentboard-dev/denylist.txt.
// Matches are reported by entry number only, so logs never print a private term.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EMAIL = /@(users\.noreply\.github\.com|example\.invalid)$/i;

/** @param {string} raw */
export function parseTerms(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

/**
 * Line 0 is the file path itself; lines 1..n are the content.
 * @param {{ path: string, text: string }[]} files
 * @param {string[]} terms lowercased
 */
export function findMatches(files, terms) {
  const hits = [];
  for (const file of files) {
    const lines = [file.path, ...file.text.split(/\r?\n/)];
    lines.forEach((line, i) => {
      const low = line.toLowerCase();
      terms.forEach((term, j) => {
        if (low.includes(term)) hits.push({ path: file.path, line: i, term: j + 1 });
      });
    });
  }
  return hits;
}

function loadTerms(env = process.env) {
  if (env.AGENTBOARD_DENYLIST) return parseTerms(env.AGENTBOARD_DENYLIST);
  const file = env.AGENTBOARD_DENYLIST_FILE || path.join(os.homedir(), '.agentboard-dev', 'denylist.txt');
  try {
    return parseTerms(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function collect(mode) {
  if (mode === '--staged') {
    const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
    return names.map((p) => ({ path: p, text: git(['show', `:${p}`]) }));
  }
  const names = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const files = [];
  for (const p of names) {
    try {
      files.push({ path: p, text: fs.readFileSync(p, 'utf8') });
    } catch {
      // deleted in the working tree; the staged scan covers commits
    }
  }
  return files;
}

function main(argv) {
  const mode = argv[0] || '--all';
  const terms = loadTerms();
  if (!terms || terms.length === 0) {
    console.error('check-denylist: no denylist found. Create ~/.agentboard-dev/denylist.txt (one term per line) or set AGENTBOARD_DENYLIST.');
    return 1;
  }
  if (mode === '--staged') {
    let email = '';
    try {
      email = git(['config', 'user.email']).trim();
    } catch {
      // unset
    }
    if (!ALLOWED_EMAIL.test(email)) {
      console.error('check-denylist: the commit email must be a GitHub no-reply address or the local placeholder.');
      return 1;
    }
  }
  const hits = findMatches(collect(mode), terms);
  for (const h of hits) console.error(`denylist: ${h.path}:${h.line === 0 ? '(path)' : h.line} matches entry #${h.term}`);
  if (hits.length) {
    console.error(`check-denylist: ${hits.length} match(es). Remove them before committing.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
