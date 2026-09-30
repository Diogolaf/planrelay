import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openBoard, readRegistry, transact } from '../src/core/store.js';
import { runHook } from '../src/hooks/run.js';
import { tempRepo, T0, MIN } from './helpers.js';

/**
 * The per-hook budget (§9), measured in-process for one hook call. Node's own start-up, roughly
 * 40–80 ms, comes on top and is outside the tool's control.
 */
const BUDGET_MS = Number(process.env.AGENTBOARD_PERF_BUDGET_MS ?? (process.env.CI ? 300 : 100));
const RUNS = 7;
const TASKS = 1000;

/** Each session runs in its own live host process, as in two terminals (one host process has one live agent). */
const PIDS = { s1: process.pid, s2: process.ppid };
const envOf = (session) => ({ CLAUDE_PID: String(PIDS[session] ?? process.pid) });

/** Runs one hook and returns its output and its time in ms. */
function timed(repo, event, session, extra, now) {
  const start = performance.now();
  const out = runHook({ hook_event_name: event, session_id: session, cwd: repo, ...extra }, { env: envOf(session), now });
  return { out, ms: performance.now() - start };
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

test(`hooks stay within budget on a ${TASKS.toLocaleString('en-US')}-task board`, (t) => {
  const repo = tempRepo();
  transact(openBoard(repo), () => ({
    events: Array.from({ length: TASKS }, (_, i) => ({
      type: 'task.created',
      actor: 'seed',
      data: {
        task: {
          id: i + 1, kind: 'task', title: `Task ${i + 1}`, description: 'x'.repeat(200), origin: 'human', createdBy: 'human',
          approved: true, rank: i + 1, dependsOn: i > 0 && i % 3 === 0 ? [i] : [],
        },
      },
    })),
  }), { now: T0 });

  /** @type {Record<string, number[]>} */
  const times = { SessionStart: [], UserPromptSubmit: [], PreToolUse: [], PostToolUse: [] };

  // SessionStart: each run is a new session in the same host process (as after /clear), the full
  // path with claim inheritance and the brief. The first call warms up the modules and is not timed.
  timed(repo, 'SessionStart', 'warm-up', { source: 'startup' }, T0);
  for (let i = 1; i <= RUNS; i++) {
    const { out, ms } = timed(repo, 'SessionStart', `new-${i}`, { source: 'startup' }, T0);
    assert.match(out, /additionalContext/, 'SessionStart returns the brief');
    times.SessionStart.push(ms);
  }

  // Two live agents: s2 has just edited a shared file, so s1's edits of it are denied (§10).
  const shared = path.join(repo, 'src', 'shared.js');
  timed(repo, 'SessionStart', 's1', { source: 'startup' }, T0);
  timed(repo, 'SessionStart', 's2', { source: 'startup' }, T0);
  timed(repo, 'PostToolUse', 's2', { tool_name: 'Edit', tool_input: { file_path: shared } }, T0);

  for (let i = 1; i <= RUNS; i++) {
    const at = T0 + i * MIN;
    times.UserPromptSubmit.push(timed(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }, at).ms);
    const pre = timed(repo, 'PreToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: shared } }, at);
    assert.match(pre.out, /"permissionDecision":"deny"/, 'PreToolUse runs the full lock check and denies');
    times.PreToolUse.push(pre.ms);
    times.PostToolUse.push(timed(repo, 'PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', `f${i}.js`) } }, at).ms);
  }

  // Hooks fail open and print nothing on an internal error, so check that the timed calls did their work.
  const board = openBoard(repo);
  assert.equal(fs.existsSync(board.files.errors), false, 'no hook logged an error');
  const reg = readRegistry(board);
  assert.equal(reg.agents.s1.lastSeen, T0 + RUNS * MIN, 'UserPromptSubmit and PostToolUse refreshed the agent');
  assert.equal(Object.values(reg.touches).filter((x) => x.agent === 's1').length, RUNS, 'PostToolUse recorded every edit');

  const slow = [];
  for (const [hook, list] of Object.entries(times)) {
    const m = median(list);
    t.diagnostic(`${hook}: median ${m.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
    if (!(m < BUDGET_MS)) slow.push(`${hook} ${m.toFixed(1)} ms`);
  }
  assert.deepEqual(slow, [], `median hook time over the ${BUDGET_MS} ms budget: ${slow.join(', ')}`);
});
