import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runHook } from '../../src/hooks/run.js';
import { currentHost } from '../../src/core/agents.js';
import { openBoard, transact, readState, readRegistry } from '../../src/core/store.js';
import { createTask, claimTask, postMessage } from '../../src/core/ops.js';
import { gitEnv, tempRepo, tempDir, T0, MIN, HOUR } from '../helpers.js';

/** A pid no process has: what a killed terminal leaves behind. */
const DEAD_PID = 2 ** 31 - 1;
/** Each session runs in its own live host process, as in two terminals (one host process has one live agent). */
const PIDS = { s1: process.pid, s2: process.ppid };
const envOf = (session) => ({ CLAUDE_PID: String(PIDS[session] ?? process.pid) });
const hook = (repo, event, session, extra = {}, now = T0, env = envOf(session)) =>
  runHook({ hook_event_name: event, session_id: session, cwd: repo, ...extra }, { env, now });
const context = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');
const errorsLog = (repo) => path.join(repo, '.git', 'agentboard', 'errors.log');

function asAgent(repo, agentId, op, input, now = T0) {
  const board = openBoard(repo);
  return transact(board, (state, reg) => op({ state, reg, cfg: board.config, agentId, now }, input), { now });
}

/** s1 creates task #1 and claims it. */
function claimOne(repo, title = 'Filter by prep time') {
  asAgent(repo, 's1', createTask, { title, requestedByHuman: true });
  asAgent(repo, 's1', claimTask, { id: 1 });
}

test('SessionStart registers the agent and briefs it', () => {
  const repo = tempRepo();
  const text = context(hook(repo, 'SessionStart', 's1', { source: 'startup' }));
  assert.match(text, /you are agent Amber/);
  assert.match(text, /No task claimed\. Board: 0 backlog/);
  const agent = readRegistry(openBoard(repo)).agents.s1;
  assert.equal(agent.pid, process.pid);
  assert.equal(agent.host, currentHost(envOf('s1')));
  assert.equal(agent.folder, repo);
  assert.equal(agent.cursor, 0); // a board sequence number, never a time
});

test('the brief points to the project rules and reports config problems', () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo, '.agentboard'));
  fs.writeFileSync(path.join(repo, '.agentboard', 'rules.md'), 'Run the tests before completing a task.\n');
  fs.writeFileSync(path.join(repo, '.agentboard', 'config.json'), '{ "maxPings": "many" }');
  const text = context(hook(repo, 'SessionStart', 's1'));
  assert.match(text, /this project has rules in .*rules\.md/);
  assert.match(text, /Config problems .*maxPings must be a number/);
});

test('a new session in the same folder inherits the claim of an ended one', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo);
  hook(repo, 'SessionEnd', 's1', { reason: 'prompt_input_exit' }, T0 + MIN);
  const text = context(hook(repo, 'SessionStart', 's2', { source: 'startup' }, T0 + 2 * MIN));
  assert.match(text, /you are agent Amber/); // the folder's name, for continuity
  assert.match(text, /Your task: #1 Filter by prep time/);
  assert.equal(readState(openBoard(repo)).tasks[1].assignee, 's2');
});

test('a live session\'s SessionStart (source compact) never takes a gone agent\'s claim', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2'); // a second agent in the same folder, without a task
  claimOne(repo);
  hook(repo, 'SessionEnd', 's1', { reason: 'prompt_input_exit' }, T0 + MIN);
  // s2 keeps working; Claude Code compacts its conversation and fires SessionStart again, same session id
  const text = context(hook(repo, 'SessionStart', 's2', { source: 'compact' }, T0 + 2 * MIN));
  assert.match(text, /No task claimed/);
  assert.equal(readState(openBoard(repo)).tasks[1].assignee, 's1');
  // only a new session inherits
  assert.match(context(hook(repo, 'SessionStart', 's3', { source: 'startup' }, T0 + 3 * MIN)), /Your task: #1 Filter by prep time/);
  assert.equal(readState(openBoard(repo)).tasks[1].assignee, 's3');
});

test('/clear: the new session of the same host process continues the task and is not pinged about it', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo);
  const same = envOf('s1');
  // the new session's SessionStart may arrive before the old one's SessionEnd
  const text = context(hook(repo, 'SessionStart', 's3', { source: 'clear' }, T0 + MIN, same));
  assert.equal(hook(repo, 'SessionEnd', 's1', { reason: 'clear' }, T0 + MIN, same), '');
  assert.match(text, /you are agent Amber/);
  assert.match(text, /Your task: #1 Filter by prep time/);
  assert.doesNotMatch(text, /continues this task/);
  const board = openBoard(repo);
  const state = readState(board);
  const reg = readRegistry(board);
  assert.equal(state.tasks[1].assignee, 's3');
  assert.equal(state.messages.at(-1).text, 'Amber continues this task in a new session.');
  assert.equal(reg.agents.s1.endedAt, T0 + MIN);
  // the cursor starts after the session's own inheritance events
  assert.equal(reg.agents.s3.cursor, state.seq);
  assert.equal(reg.agents.s3.prevCursor, state.seq);
  assert.equal(hook(repo, 'UserPromptSubmit', 's3', { prompt: 'go on' }, T0 + 2 * MIN, same), '');
});

/** The id of the open question on task 1. */
const openQuestion = (repo) => readState(openBoard(repo)).tasks[1].openQuestions[0].id;

test('/clear: an answer that came after the last prompt reaches the new session in its brief, once', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2');
  claimOne(repo);
  asAgent(repo, 's1', postMessage, { taskId: 1, kind: 'question', to: 'Jade', text: 'Is the CSV schema final?' });
  hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go on' }, T0 + MIN);
  const q = openQuestion(repo);
  asAgent(repo, 's2', postMessage, { taskId: 1, kind: 'answer', replyTo: q, text: 'Yes, final.' }, T0 + 2 * MIN);
  const same = envOf('s1');
  // the new session's SessionStart may arrive before the old one's SessionEnd
  const text = context(hook(repo, 'SessionStart', 's3', { source: 'clear' }, T0 + 3 * MIN, same));
  hook(repo, 'SessionEnd', 's1', { reason: 'clear' }, T0 + 3 * MIN, same);
  assert.match(text, /Your task: #1 Filter by prep time/);
  assert.match(text, new RegExp(`Updates since you were last here:\n#1 · Jade answered your question ${q} "Is the CSV schema final\\?": "Yes, final\\."`));
  assert.equal(text.match(/answered your question/g).length, 1);
  assert.equal(hook(repo, 'UserPromptSubmit', 's3', { prompt: 'go on' }, T0 + 4 * MIN, same), '');
});

test('/clear: a question that came after the last prompt reaches the new session, which can answer it', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2');
  claimOne(repo);
  asAgent(repo, 's1', postMessage, { taskId: 1, kind: 'question', to: 'Jade', text: 'Is the CSV schema final?' });
  const q = openQuestion(repo);
  const jade = envOf('s2');
  hook(repo, 'SessionEnd', 's2', { reason: 'clear' }, T0 + MIN, jade);
  const text = context(hook(repo, 'SessionStart', 's4', { source: 'clear' }, T0 + MIN, jade));
  assert.match(text, /you are agent Jade/);
  assert.match(text, new RegExp(`\n#1 · Amber asks you: "Is the CSV schema final\\?" \\(answer with post_message kind "answer", replyTo "${q}"\\)`));
  assert.equal(text.match(/asks you/g).length, 1);
  assert.equal(hook(repo, 'UserPromptSubmit', 's4', { prompt: 'hello' }, T0 + 2 * MIN, jade), '');
  asAgent(repo, 's4', postMessage, { taskId: 1, kind: 'answer', replyTo: q, text: 'Yes, final.' }, T0 + 2 * MIN);
  assert.deepEqual(readState(openBoard(repo)).tasks[1].openQuestions, []); // Amber's task is no longer blocked
  assert.match(context(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go on' }, T0 + 3 * MIN)), /#1 · Jade answered your question/);
});

test('a killed terminal: the session that inherits its claim is told what was posted on the task since the dead session\'s last prompt', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's2');
  hook(repo, 'SessionStart', 's1', {}, T0, { CLAUDE_PID: String(DEAD_PID) });
  claimOne(repo);
  asAgent(repo, 's2', postMessage, { taskId: 1, kind: 'comment', text: 'Heads up: the recipes API now pages its results.' }, T0 + MIN);
  // no SessionEnd ever came, and s1's host process is gone
  const text = context(hook(repo, 'SessionStart', 's3', {}, T0 + 2 * MIN));
  assert.match(text, /Your task: #1 Filter by prep time/);
  assert.match(text, /Updates since you were last here:\n#1 · Amber \(comment\): "Heads up: the recipes API now pages its results\."/);
  assert.equal(hook(repo, 'UserPromptSubmit', 's3', { prompt: 'go on' }, T0 + 3 * MIN), '');
});

test('a killed terminal: a new session in the same folder takes over the dead session\'s claim', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1', {}, T0, { CLAUDE_PID: String(DEAD_PID) });
  claimOne(repo);
  // no SessionEnd ever came, and s1's host process is gone
  const text = context(hook(repo, 'SessionStart', 's2', {}, T0 + MIN));
  assert.match(text, /Your task: #1 Filter by prep time/);
  const board = openBoard(repo);
  assert.equal(readState(board).tasks[1].assignee, 's2');
  assert.equal(readRegistry(board).agents.s1.endedAt, T0 + MIN);
});

test('UserPromptSubmit is silent until something needs the agent, and its cursor follows sequence numbers', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2');
  claimOne(repo, 'A');
  assert.equal(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }, T0 + MIN), '');
  assert.equal(readRegistry(openBoard(repo)).agents.s1.cursor, 2);
  // stamped by its writer's clock before s1's last prompt, but committed after it: still shown
  asAgent(repo, 's2', postMessage, { taskId: 1, kind: 'comment', text: 'Heads up: API changed.' }, T0);
  const text = context(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }, T0 + 3 * MIN));
  assert.match(text, /#1 · Jade \(comment\): "Heads up: API changed\."/);
  const s1 = readRegistry(openBoard(repo)).agents.s1;
  assert.deepEqual([s1.prevCursor, s1.cursor], [2, 3]);
  assert.equal(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }, T0 + 4 * MIN), '');
});

test('a session back after claimTimeoutHours loses its claim at its first prompt and is told', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo);
  const text = context(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'where were we?' }, T0 + 25 * HOUR));
  assert.match(text, /#1 · Released Amber's claim after 24 h without activity\./);
  const board = openBoard(repo);
  const state = readState(board);
  const s1 = readRegistry(board).agents.s1;
  assert.equal(state.tasks[1].assignee, null);
  assert.equal(s1.endedAt, null); // the session is back
  assert.equal(s1.cursor, state.seq);
  assert.equal(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }, T0 + 25 * HOUR + MIN), '');
});

test('PreToolUse denies an edit to a file another active agent is working on', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2');
  asAgent(repo, 's2', createTask, { title: 'Sign in with Google', requestedByHuman: true });
  asAgent(repo, 's2', claimTask, { id: 1 });
  const file = path.join(repo, 'src', 'auth.js');
  hook(repo, 'PostToolUse', 's2', { tool_name: 'Edit', tool_input: { file_path: file } }, T0 + MIN);
  const out = hook(repo, 'PreToolUse', 's1', { tool_name: 'Write', tool_input: { file_path: file } }, T0 + 2 * MIN);
  const decision = JSON.parse(out).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /^src\/auth\.js is being edited by Jade on #1\. /);
  // the title is board text, so it is fenced as data (§9)
  assert.match(decision.permissionDecisionReason, /<agentboard-data>\n#1 Sign in with Google\n<\/agentboard-data>$/);
  assert.equal(hook(repo, 'PreToolUse', 's1', { tool_name: 'Read', tool_input: { file_path: file } }, T0 + 2 * MIN), '');
  assert.equal(hook(repo, 'PreToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'README.md') } }, T0 + 2 * MIN), '');
  assert.equal(hook(repo, 'PreToolUse', 's2', { tool_name: 'Edit', tool_input: { file_path: file } }, T0 + 2 * MIN), '');
});

test('PostToolUse mirrors todos and records files inside the repository only', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo, 'A');
  const todos = [
    { content: 'Model', status: 'completed', activeForm: 'Modeling' },
    { content: 'API', status: 'in_progress', activeForm: 'Building the API' },
  ];
  hook(repo, 'PostToolUse', 's1', { tool_name: 'TodoWrite', tool_input: { todos } });
  hook(repo, 'PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'a.js') } });
  hook(repo, 'PostToolUse', 's1', { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'nb', 'prep.ipynb') } });
  hook(repo, 'PostToolUse', 's1', { tool_name: 'Write', tool_input: { file_path: path.join(tempDir(), 'notes.md') } });
  const board = openBoard(repo);
  const t = readState(board).tasks[1];
  assert.deepEqual(t.checklist, [{ text: 'Model', done: true }, { text: 'API', done: false }]);
  assert.deepEqual(t.files.map((f) => f.path), ['src/a.js', 'nb/prep.ipynb']);
  assert.equal(readRegistry(board).activity[1], T0);
});

test('PostToolUse records the last file the agent edited', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  hook(repo, 'PostToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'filters', 'diet.js') } }, T0 + MIN);
  const board = openBoard(repo);
  let agent = readRegistry(board).agents.s1;
  assert.equal(agent.lastFile, 'src/filters/diet.js');
  assert.equal(agent.lastFileAt, T0 + MIN);
  assert.equal(agent.lastSeen, T0 + MIN);
  // a file outside the repository, or another tool, leaves it as it was
  hook(repo, 'PostToolUse', 's1', { tool_name: 'Write', tool_input: { file_path: path.join(tempDir(), 'notes.md') } }, T0 + 2 * MIN);
  hook(repo, 'PostToolUse', 's1', { tool_name: 'TodoWrite', tool_input: { todos: [] } }, T0 + 3 * MIN);
  agent = readRegistry(board).agents.s1;
  assert.deepEqual([agent.lastFile, agent.lastFileAt, agent.lastSeen], ['src/filters/diet.js', T0 + MIN, T0 + 3 * MIN]);
});

test('SessionEnd marks the agent gone and leaves its claim with the folder', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo);
  assert.equal(hook(repo, 'SessionEnd', 's1', { reason: 'logout' }, T0 + MIN), '');
  const board = openBoard(repo);
  assert.equal(readRegistry(board).agents.s1.endedAt, T0 + MIN);
  assert.equal(readState(board).tasks[1].assignee, 's1');
});

test('two worktrees of one repository: one board, each worktree inherits its own claim, and locks span worktrees', () => {
  const repo = tempRepo();
  const wt = path.join(tempDir(), 'photos');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'photos', wt], { cwd: repo, env: gitEnv(), stdio: 'ignore' });
  hook(repo, 'SessionStart', 's1');
  hook(wt, 'SessionStart', 's2');
  assert.equal(openBoard(wt).dir, path.join(repo, '.git', 'agentboard'));
  assert.equal(openBoard(repo).dir, path.join(repo, '.git', 'agentboard'));
  asAgent(repo, 's1', createTask, { title: 'Filter by prep time', requestedByHuman: true });
  asAgent(repo, 's1', createTask, { title: 'Cache photos', requestedByHuman: true });
  asAgent(repo, 's1', claimTask, { id: 1 });
  asAgent(wt, 's2', claimTask, { id: 2 });
  const claims = readState(openBoard(wt)).tasks;
  assert.deepEqual([claims[1].claim.folder, claims[2].claim.folder], [repo, wt]);
  // the same file, edited in the other worktree, is locked: a file is its path inside the repository (§10)
  hook(wt, 'PostToolUse', 's2', { tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'cache.js') } }, T0 + MIN);
  const out = hook(repo, 'PreToolUse', 's1', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src', 'cache.js') } }, T0 + 2 * MIN);
  const decision = JSON.parse(out).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /^src\/cache\.js is being edited by Jade on #2\. /);
  // both sessions end, the main checkout's last; each new session takes its own worktree's claim, not the latest one
  hook(wt, 'SessionEnd', 's2', { reason: 'prompt_input_exit' }, T0 + 3 * MIN);
  hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go on' }, T0 + 4 * MIN);
  hook(repo, 'SessionEnd', 's1', { reason: 'prompt_input_exit' }, T0 + 5 * MIN);
  const inWt = context(hook(wt, 'SessionStart', 's3', {}, T0 + 6 * MIN, envOf('s1')));
  const inRepo = context(hook(repo, 'SessionStart', 's4', {}, T0 + 7 * MIN, envOf('s2')));
  assert.match(inWt, /you are agent Jade[\s\S]*Your task: #2 Cache photos/);
  assert.match(inRepo, /you are agent Amber[\s\S]*Your task: #1 Filter by prep time/);
  const state = readState(openBoard(repo));
  assert.deepEqual([state.tasks[1].assignee, state.tasks[2].assignee], ['s4', 's3']);
});

test('a deleted worktree: its hooks keep working, and its claim is released once the folder stays gone', () => {
  const repo = tempRepo();
  const wt = path.join(repo, '.worktrees', 'photos');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'photos', wt], { cwd: repo, env: gitEnv(), stdio: 'ignore' });
  hook(wt, 'SessionStart', 's1');
  hook(repo, 'SessionStart', 's2');
  claimOne(repo, 'Cache photos');
  assert.equal(readState(openBoard(repo)).tasks[1].claim.folder, wt);
  fs.rmSync(wt, { recursive: true, force: true });
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'cache.js') } };
  assert.equal(hook(wt, 'PreToolUse', 's1', edit, T0 + MIN), '');
  assert.equal(hook(wt, 'PostToolUse', 's1', edit, T0 + MIN), '');
  assert.equal(hook(wt, 'UserPromptSubmit', 's1', { prompt: 'go' }, T0 + 2 * MIN), '');
  assert.equal(hook(wt, 'SessionEnd', 's1', { reason: 'other' }, T0 + 3 * MIN), '');
  // housekeeping in another agent's hook: missing on sweeps 10 minutes apart, and its owner is gone
  hook(repo, 'UserPromptSubmit', 's2', { prompt: 'go' }, T0 + 12 * MIN);
  const state = readState(openBoard(repo));
  assert.equal(state.tasks[1].assignee, null);
  assert.equal(state.messages.at(-1).text, "Released Amber's claim: the working folder was removed.");
  assert.equal(fs.existsSync(errorsLog(repo)), false);
});

test('input in shapes this version does not know is ignored, never an error', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  claimOne(repo, 'A');
  hook(repo, 'PostToolUse', 's1', { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Model', status: 'pending' }] } });
  const odd = [
    ['PostToolUse', { tool_name: 'TodoWrite', tool_input: { items: [{ content: 'Other' }] } }],
    ['PostToolUse', { tool_name: 'TodoWrite', tool_input: { todos: [{ text: 'Other', state: 'done' }] } }],
    ['PostToolUse', { tool_name: 'TodoWrite', tool_input: null }],
    ['PostToolUse', { tool_name: 'Edit', tool_input: 'src/a.js' }],
    ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 42 } }],
    ['PostToolUse', { tool_name: 'Edit', tool_input: { file_path: repo } }],
    ['PostToolUse', {}],
    ['PreToolUse', { tool_name: 'Edit' }],
    ['PreToolUse', { tool_name: ['Edit'], tool_input: { file_path: path.join(repo, 'a.js') } }],
    ['UserPromptSubmit', { prompt: { text: 'go' }, permission_mode: 'plan', future_field: [1, 2] }],
    ['Stop', {}],
    ['PreCompact', { trigger: 'auto' }],
  ];
  for (const [event, extra] of odd) assert.equal(hook(repo, event, 's1', extra, T0 + MIN), '', `${event} ${JSON.stringify(extra)}`);
  for (const input of [null, undefined, 7, 'SessionStart', [], { hook_event_name: 'SessionStart', cwd: repo }]) {
    assert.equal(runHook(input, { env: envOf('s1') }), '');
  }
  assert.equal(runHook({ hook_event_name: 'SessionStart', session_id: 42, cwd: repo }, { env: envOf('s1') }), '');
  assert.equal(runHook({ hook_event_name: 42, session_id: 's1', cwd: repo }, { env: envOf('s1') }), '');
  const t = readState(openBoard(repo)).tasks[1];
  assert.deepEqual(t.checklist, [{ text: 'Model', done: false }]);
  assert.deepEqual(t.files, []);
  assert.equal(fs.existsSync(errorsLog(repo)), false);
});

test('fail-open: internal errors are logged, print nothing and never throw', () => {
  const repo = tempRepo();
  hook(repo, 'SessionStart', 's1');
  const registry = path.join(repo, '.git', 'agentboard', 'agents.json');
  fs.rmSync(registry);
  fs.mkdirSync(registry); // the registry cannot be read
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.js') } };
  assert.equal(hook(repo, 'SessionStart', 's1'), '');
  assert.equal(hook(repo, 'UserPromptSubmit', 's1', { prompt: 'go' }), '');
  assert.equal(hook(repo, 'PreToolUse', 's1', edit), '');
  assert.equal(hook(repo, 'PostToolUse', 's1', edit), '');
  assert.equal(hook(repo, 'SessionEnd', 's1'), '');
  const log = fs.readFileSync(errorsLog(repo), 'utf8');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
    assert.match(log, new RegExp(`hook ${event}: `));
  }
  const broken = tempRepo();
  fs.writeFileSync(path.join(broken, '.git', 'agentboard'), 'not a folder');
  assert.equal(hook(broken, 'SessionStart', 's1'), '');
});
