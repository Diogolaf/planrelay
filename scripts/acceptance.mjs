#!/usr/bin/env node
// The scripted acceptance (spec section 17) on a throwaway "recipes-app" project:
//   solo  one agent creates, works on and completes tasks across two sessions
//   pair  two agents in parallel, with a dependency, a question to the human and a lock conflict
//
// usage: node scripts/acceptance.mjs [solo|pair|all] [--model haiku] [--budget 0.40] [--keep]
//
// It starts real Claude Code sessions on the account of whoever runs it: two for solo, three for
// pair, never more than five in one run. --budget is the limit per session in USD, and every
// prompt has a 5-minute limit. Whatever happens, every session it opened is stopped at the end.
//
// Each scenario gets a fresh folder in the OS temp folder: the project (a git repository with its
// own placeholder identity), the MCP config next to it, and one transcript per session
// (<label>.jsonl). The folder is removed at the end, unless --keep is given or the scenario
// failed; then its path is printed. Files and transcripts are never printed, only where they
// are; a failed check says in one line what it found instead.
//
// For tests: AGENTBOARD_ACCEPTANCE_CLAUDE, a JSON array such as
// ["node","test/fixtures/fake-claude.mjs"], replaces the `claude` command, so no session starts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBoard, readState } from '../src/core/store.js';
import {
  checkPair, checkSolo, closeAll, killAll, MAX_SESSIONS, mcpConfigOf, openSession, PROMPTS, runSession,
} from './lib/acceptance.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const USAGE = 'usage: node scripts/acceptance.mjs [solo|pair|all] [--model haiku] [--budget 0.40] [--keep]';

const say = (line) => console.log(line);
const usd = (n) => `$${n.toFixed(4)}`;
const seconds = (since) => Math.round((Date.now() - since) / 1000);

/** The options, or null when the arguments are not understood. The model and the budget go on a command line, so their shape is checked. */
function parseArgs(argv) {
  const opts = { scenario: 'all', model: 'haiku', budget: 0.4, keep: false };
  const rest = [...argv];
  let named = false;
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--keep') opts.keep = true;
    else if (arg === '--model' && /^[\w.:[\]-]+$/.test(rest[0] ?? '')) opts.model = rest.shift();
    else if (arg === '--budget' && Number(rest[0]) > 0 && Number.isFinite(Number(rest[0]))) opts.budget = Number(rest.shift());
    else if (!named && ['solo', 'pair', 'all'].includes(arg)) [opts.scenario, named] = [arg, true];
    else return null;
  }
  return opts;
}

/** The command that replaces `claude` in tests (AGENTBOARD_ACCEPTANCE_CLAUDE), or undefined. */
function standIn() {
  const raw = process.env.AGENTBOARD_ACCEPTANCE_CLAUDE;
  if (raw === undefined) return undefined; // set but empty is a mistake, never a reason to run the real command
  let list = null;
  try {
    list = JSON.parse(raw);
  } catch {
    // reported below
  }
  if (!Array.isArray(list) || !list.length || !list.every((part) => typeof part === 'string' && part !== '')) {
    throw new Error('AGENTBOARD_ACCEPTANCE_CLAUDE must be a JSON array of texts, such as ["node","test/fixtures/fake-claude.mjs"]');
  }
  // sessions run in the throwaway project, so a file named from this folder gets its full path
  return list.map((part, i) => (i > 0 && fs.existsSync(part) ? path.resolve(part) : part));
}

/**
 * The throwaway project `<parent>/recipes-app`: a git repository with one commit, made without
 * the user's git configuration. Its own config holds a placeholder identity and an empty hooks
 * folder, so nothing run in it later picks up the user's identity, signing or hooks either.
 */
function makeProject(parent) {
  const project = path.join(parent, 'recipes-app');
  const gitConfig = path.join(parent, 'gitconfig');
  const noHooks = path.join(parent, 'no-hooks');
  fs.mkdirSync(project);
  fs.mkdirSync(noHooks);
  fs.writeFileSync(gitConfig, '');
  fs.writeFileSync(path.join(project, 'README.md'), '# recipes-app\n');
  fs.writeFileSync(path.join(project, 'recipes.md'), '# Recipes\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) => execFileSync('git', args, { cwd: project, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'recipes');
  git('config', 'user.email', 'recipes@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', noHooks);
  git('add', 'README.md', 'recipes.md');
  git('commit', '-q', '-m', 'init');
  return project;
}

/** The project's files the checks read, by name: the ones the scenarios name and every file a task lists. */
function projectFiles(project, board) {
  const names = new Set(['README.md', 'recipes.md', 'shopping.md']);
  for (const t of Object.values(readState(board).tasks)) for (const f of t.files) names.add(f.path);
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of names) {
    const file = path.resolve(project, name);
    if (path.relative(project, file).startsWith('..')) continue;
    try {
      files[name] = fs.readFileSync(file, 'utf8');
    } catch {
      // missing: the checks say so
    }
  }
  return files;
}

/**
 * Starts the sessions of one scenario and prints a line when each starts and ends: its label, how
 * long it took and what it cost. `totals` counts the sessions and adds up their cost; a held
 * session reports its total so far with every turn, so its last turn's figure is its cost.
 */
function sessionsIn(parent, project, opts, totals) {
  const base = {
    cwd: project, command: opts.command, pluginDir: ROOT, mcpConfig: path.join(parent, 'mcp.json'), model: opts.model, budgetUsd: opts.budget,
  };
  const transcript = (label) => path.join(parent, `${label}.jsonl`);
  return {
    /** A one-shot session. */
    async once(label, prompt) {
      const since = Date.now();
      say(`  ${label}: started`);
      totals.sessions += 1;
      try {
        const turn = await runSession({ ...base, label, prompt, transcript: transcript(label) });
        totals.cost += turn.cost;
        say(`  ${label}: ended after ${seconds(since)} s, ${usd(turn.cost)}`);
        return turn;
      } catch (err) {
        totals.cost += err?.turn?.cost ?? 0;
        say(`  ${label}: failed after ${seconds(since)} s`);
        throw err;
      }
    },
    /** A session that stays open between its prompts. */
    async open(label) {
      const opened = Date.now();
      say(`  ${label}: started, stays open`);
      totals.sessions += 1;
      const session = await openSession({ ...base, label, transcript: transcript(label) });
      let cost = 0;
      let turns = 0;
      return {
        async send(prompt) {
          const since = Date.now();
          turns += 1;
          try {
            const turn = await session.send(prompt);
            cost = turn.cost;
            say(`  ${label}: turn ${turns} answered after ${seconds(since)} s, ${usd(cost)} so far`);
            return turn;
          } catch (err) {
            cost = err?.turn?.cost || cost;
            say(`  ${label}: turn ${turns} failed after ${seconds(since)} s`);
            throw err;
          }
        },
        async close() {
          await session.close();
          totals.cost += cost;
          say(`  ${label}: ended after ${seconds(opened)} s, ${usd(cost)}`);
        },
      };
    },
  };
}

/** Each scenario: `run` starts its sessions and returns their turns by label; `check` judges the board they leave. */
const SCENARIOS = {
  solo: {
    title: 'one agent, two sessions',
    check: checkSolo,
    async run(sessions) {
      const first = await sessions.once('first', PROMPTS.soloFirst);
      const second = await sessions.once('second', PROMPTS.soloSecond); // a new process in the same folder
      return { first: [first], second: [second] };
    },
  },
  pair: {
    title: 'two agents in parallel',
    check: checkPair,
    async run(sessions) {
      const a = await sessions.open('A');
      try {
        const asked = await a.send(PROMPTS.pairAsk);
        const b = await sessions.once('B', PROMPTS.pairRefused); // while A lives: its lock holds
        const answered = await a.send(PROMPTS.pairAnswer);
        const c = await sessions.once('C', PROMPTS.pairShopping);
        return { A: [asked, answered], B: [b], C: [c] };
      } finally {
        await a.close();
      }
    },
  },
};

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  say(USAGE);
  process.exit(0);
}
const opts = parseArgs(process.argv.slice(2));
if (!opts) {
  console.error(USAGE);
  process.exit(1);
}

const totals = { sessions: 0, cost: 0 };
/** The folders made, and whether each stays. @type {{ dir: string, keep: boolean }[]} */
const folders = [];
let failed = 0;

// Ctrl+C, a closed terminal or a stop request: every session is stopped and no other starts.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    closeAll().finally(() => {
      for (const { dir } of folders) say(`left: ${dir}`);
      process.exit(130);
    });
  });
}
// however the script ends, an uncaught error included, no session outlives it
process.on('exit', () => killAll());

try {
  opts.command = standIn();
  say(opts.command
    ? 'AGENTBOARD_ACCEPTANCE_CLAUDE replaces the claude command: no real session starts.'
    : `Starting real Claude Code sessions on your account: at most ${MAX_SESSIONS} in this run.`);
  for (const name of opts.scenario === 'all' ? ['solo', 'pair'] : [opts.scenario]) {
    const scenario = SCENARIOS[name];
    const folder = { dir: fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-acceptance-'))), keep: true };
    folders.push(folder);
    say(`${name}: ${scenario.title} (model ${opts.model}, up to ${usd(opts.budget)} a session)`);
    const project = makeProject(folder.dir);
    fs.writeFileSync(path.join(folder.dir, 'mcp.json'), `${JSON.stringify(mcpConfigOf(ROOT), null, 2)}\n`);
    const turns = await scenario.run(sessionsIn(folder.dir, project, opts, totals));
    const board = openBoard(project);
    const checks = scenario.check({ board, turns, files: projectFiles(project, board) });
    for (const c of checks) say(`  ${c.ok ? 'ok    ' : 'FAILED'}  ${c.name}${c.ok ? '' : `: ${c.detail}`}`);
    const bad = checks.filter((c) => !c.ok).length;
    failed += bad;
    folder.keep = opts.keep || bad > 0;
  }
} catch (err) {
  // a session that failed, or the script itself: nothing more is started
  failed += 1;
  say(`  FAILED  ${err?.name === 'SessionError' ? `session ${err.message}` : `acceptance: ${err?.message ?? err}`}`);
} finally {
  await closeAll();
}

say(`sessions: ${totals.sessions} of at most ${MAX_SESSIONS}, total cost ${usd(totals.cost)}`);
for (const { dir, keep } of folders) {
  if (keep) {
    say(`kept: ${dir} (the project, and a transcript per session)`);
    continue;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    say(`could not remove: ${dir}`);
  }
}
say(failed ? `verdict: FAILED (${failed} problem${failed === 1 ? '' : 's'})` : 'verdict: passed');
process.exitCode = failed ? 1 : 0;
