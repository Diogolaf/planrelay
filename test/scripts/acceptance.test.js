// Tests of the acceptance script (scripts/acceptance.mjs and scripts/lib/acceptance.mjs).
// No test starts a real Claude Code session: the `claude` command is always
// test/fixtures/fake-claude.mjs, and the boards the checks judge are built with the plugin's real
// hooks and board tools (test/fixtures/acceptance-sessions.js). Every name and text is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boardTool, checkPair, checkSolo, childEnv, claudeArgs, MAX_SESSIONS, mcpConfigOf, newRun, openSession, PROMPTS, readTurn, REFUSED_LINE,
  runSession, windowsCommandLine,
} from '../../scripts/lib/acceptance.mjs';
import { pidAlive } from '../../src/core/mutex.js';
import { openBoard } from '../../src/core/store.js';
import * as good from '../fixtures/acceptance-sessions.js';
import { pretendSession } from '../fixtures/acceptance-sessions.js';
import { gitEnv, tempDir, tempRepo } from '../helpers.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'acceptance.mjs');
const STEPS = path.join(ROOT, 'test', 'fixtures', 'acceptance-sessions.js');
/** The stand-in for `claude`. */
const COMMAND = [process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-claude.mjs')];
const USAGE = 'usage: node scripts/acceptance.mjs [solo|pair|all] [--model haiku] [--budget 0.40] [--keep]\n';

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** An `assistant` stream line that says `text`. */
const says = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
/** This process's environment without the variables of a Claude Code session or account, and without `names`, so a test sets its own. */
const plainEnv = (...names) => Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('CLAUDE') && !names.includes(k.toUpperCase())),
);

/**
 * What a session needs to run against the stand-in, in a fresh folder: `opts` for runSession and
 * openSession (with its own counter of sessions), and `log()`, what the stand-in recorded.
 * @param {object} [script] FAKE_CLAUDE_SCRIPT: what each turn prints
 */
function fake(script = []) {
  const dir = path.join(tempDir(), 'recipes app'); // a space in every path the command line holds
  fs.mkdirSync(dir);
  const logFile = path.join(dir, 'fake.log');
  const flags = { pluginDir: ROOT, mcpConfig: path.join(dir, 'mcp.json'), model: 'haiku', budgetUsd: 0.4 };
  fs.writeFileSync(flags.mcpConfig, JSON.stringify(mcpConfigOf(ROOT)));
  const env = { ...plainEnv(), FAKE_CLAUDE_SCRIPT: JSON.stringify(script), FAKE_CLAUDE_LOG: logFile };
  return { dir, flags, opts: { cwd: dir, command: COMMAND, run: newRun(), env, ...flags }, log: () => readLog(logFile) };
}

test('claudeArgs builds the flags of a headless session', () => {
  const flags = { pluginDir: '/plugins/agentboard', mcpConfig: '/tmp/mcp.json', model: 'haiku', budgetUsd: 0.4 };
  const oneShot = [
    '-p', '--model', 'haiku', '--plugin-dir', '/plugins/agentboard',
    '--setting-sources', 'project,local',
    '--strict-mcp-config', '--mcp-config', '/tmp/mcp.json',
    '--permission-mode', 'acceptEdits',
    // the board's server has one name from --mcp-config and another when the plugin starts it
    '--allowedTools', 'mcp__agentboard__*', 'mcp__plugin_agentboard_agentboard__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
    '--disallowedTools', 'Bash', 'PowerShell',
    '--output-format', 'stream-json', '--verbose',
    '--max-budget-usd', '0.4', '--no-session-persistence',
  ];
  assert.deepEqual(claudeArgs(flags), oneShot);
  // only a held session reads stream-json; there is no way to put a prompt among the arguments
  assert.deepEqual(claudeArgs({ ...flags, held: true }), [...oneShot, '--input-format', 'stream-json']);
  assert.deepEqual(claudeArgs({ ...flags, held: false, prompt: 'Claim task #2.' }), oneShot);
});

test('childEnv drops the session variables of a surrounding Claude Code session and keeps the account\'s', () => {
  const env = childEnv({
    PATH: 'kept', HOME: 'kept', ANTHROPIC_API_KEY: 'kept', ANTHROPIC_BASE_URL: 'kept',
    CLAUDE_CONFIG_DIR: 'kept', CLAUDE_CODE_OAUTH_TOKEN: 'kept', CLAUDE_CODE_USE_BEDROCK: 'kept', CLAUDE_CODE_USE_VERTEX: 'kept',
    CLAUDECODE: 'dropped', CLAUDE_CODE_SESSION_ID: 'dropped', CLAUDE_PROJECT_DIR: 'dropped', CLAUDE_PID: 'dropped',
    CLAUDE_CODE_ENTRYPOINT: 'dropped', CLAUDE_PLUGIN_ROOT: 'dropped', claude_code_sse_port: 'dropped', NOT_SET: undefined,
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CONFIG_DIR',
    'HOME', 'PATH',
  ]);
  assert.ok(Object.values(env).every((v) => v === 'kept'));
});

test('a Windows command line holds the command and its flags, each quoted, and refuses what a shell would read', () => {
  assert.equal(
    windowsCommandLine(['claude', '-p', '--plugin-dir', 'C:\\Plugin Root\\', '--setting-sources', 'project,local', '--allowedTools', 'mcp__agentboard__*']),
    '"claude" "-p" "--plugin-dir" "C:\\Plugin Root\\\\" "--setting-sources" "project,local" "--allowedTools" "mcp__agentboard__*"',
  );
  for (const bad of ['say "hello"', '100%', 'two\nlines']) assert.throws(() => windowsCommandLine(['claude', bad]), /cannot go on a Windows command line/);
});

test('on Windows the flags reach a command that is a .cmd file unchanged', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  // what npm installs as `claude` there: a .cmd file that passes its arguments on
  const f = fake();
  const launcher = path.join(f.dir, 'claude stand-in.cmd');
  fs.writeFileSync(launcher, `@"${COMMAND[0]}" "${COMMAND[1]}" %*\r\n`);
  const flags = { ...f.flags, pluginDir: `${ROOT}\\` };
  await runSession({ ...f.opts, ...flags, command: [launcher], prompt: 'go' });
  assert.deepEqual(f.log()[0].args, claudeArgs(flags));
  assert.equal(pidAlive(f.log()[0].pid), false);
});

test('mcpConfigOf repeats the plugin\'s MCP server, with the plugin\'s folder filled in', () => {
  const config = mcpConfigOf(ROOT);
  assert.deepEqual(config, { mcpServers: { agentboard: { command: 'node', args: [`${ROOT.split(path.sep).join('/')}/src/cli.js`, 'mcp'] } } });
  assert.ok(fs.existsSync(config.mcpServers.agentboard.args[0]));
});

test('runSession sends the prompt on stdin and returns the turn: text, tool calls with their results, cost', async () => {
  const f = fake([[
    { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', exit_code: 0 }, // a kind of line the reader skips
    {
      type: 'assistant', uuid: 'u1', parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The task first.' }, { type: 'text', text: 'I will claim the task.' },
          { type: 'tool_use', id: 't1', name: 'mcp__plugin_agentboard_agentboard__claim_task', input: { id: 2 } },
        ],
      },
    },
    // a board tool answers with a list of text blocks
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 't1', is_error: true,
          content: [{ type: 'text', text: '#2 waits on #1.' }, { type: 'text', text: 'Pick a Ready task instead.' }],
        }],
      },
    },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'recipes.md' } }] } },
    // a built-in tool answers with a string, and says nothing about an error
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '# Recipes' }] }, tool_use_result: { lines: 1 } },
    { type: 'user', message: { role: 'user', content: 'a text, not a list of blocks' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'for no call' }] } },
    says('The board refused the claim.'),
    { type: 'result', subtype: 'success', is_error: false, result: 'The board said: #2 waits on #1.', total_cost_usd: 0.0375, usage: { input_tokens: 3 } },
  ]]);
  // nothing a shell would understand may reach it: the prompt is not on the command line
  const prompt = 'Claim task "#2" & tell me 100% of what it said.\nThen stop | really.';
  const transcript = path.join(f.dir, 'B.jsonl');
  // started from inside a Claude Code session: its variables stay out, the account's go in
  const env = { ...f.opts.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer-session', CLAUDE_PROJECT_DIR: ROOT, CLAUDE_CONFIG_DIR: f.dir };
  const turn = await runSession({ ...f.opts, env, prompt, transcript, label: 'B' });
  assert.deepEqual(turn, {
    text: 'The board said: #2 waits on #1.',
    cost: 0.0375,
    tools: [
      { name: 'mcp__plugin_agentboard_agentboard__claim_task', input: { id: 2 }, output: '#2 waits on #1.\nPick a Ready task instead.', isError: true },
      { name: 'Read', input: { file_path: 'recipes.md' }, output: '# Recipes', isError: false },
    ],
  });
  assert.equal(boardTool(turn.tools[0].name), 'claim_task');
  assert.equal(boardTool('mcp__agentboard__claim_task'), 'claim_task');
  assert.equal(boardTool('Read'), '');

  const [started, asked, ...more] = f.log();
  assert.deepEqual(more, []);
  assert.deepEqual(started.args, claudeArgs(f.flags));
  assert.equal(fs.realpathSync.native(started.cwd), f.dir);
  assert.deepEqual(started.claudeEnv, ['CLAUDE_CONFIG_DIR']);
  assert.deepEqual(asked, { pid: started.pid, prompt });
  assert.equal(pidAlive(started.pid), false);
  assert.equal(f.opts.run.open.size, 0);
  // the transcript holds every line the session printed, from the init line to the result
  const lines = fs.readFileSync(transcript, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 11);
  assert.deepEqual([lines[0].type, lines[0].subtype, lines[0].mcp_servers], ['system', 'init', [{ name: 'agentboard', status: 'connected' }]]);
  assert.equal(lines.at(-1).type, 'result');
  assert.equal(fs.existsSync(path.join(f.dir, 'B.stderr.txt')), false);
});

test('a held session takes several turns and ends when it is closed', async () => {
  const f = fake([[says('Which units?')], []]);
  const s = await openSession(f.opts);
  const one = await s.send('one');
  const two = await s.send('two\nwith a second line');
  const [started, ...prompts] = f.log();
  assert.ok(pidAlive(started.pid));
  await s.close();
  assert.equal(pidAlive(started.pid), false);
  await s.close(); // closing twice changes nothing

  // both prompts went to one process, one JSON line each; it reports its total cost so far
  assert.deepEqual(prompts, [{ pid: started.pid, prompt: 'one' }, { pid: started.pid, prompt: 'two\nwith a second line' }]);
  assert.deepEqual(started.args, claudeArgs({ ...f.flags, held: true }));
  assert.deepEqual(one, { text: 'done', cost: 0.01, tools: [] });
  assert.deepEqual(two, { text: 'done', cost: 0.02, tools: [] });
  assert.deepEqual([f.opts.run.started, f.opts.run.open.size], [1, 0]);
  await assert.rejects(s.send('three'), /^SessionError: session: the session has ended$/);
});

test('a turn that ends in an error, or a session that exits early, is reported with the turn\'s last text', async () => {
  const failure = (message, turn) => (err) => {
    assert.equal(err.name, 'SessionError');
    assert.match(err.message, message);
    assert.deepEqual(err.turn, turn);
    return true;
  };
  // the budget ran out
  const overBudget = fake([[says('Writing the recipe.'), { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.41 }]]);
  await assert.rejects(
    runSession({ ...overBudget.opts, label: 'first', prompt: 'go' }),
    failure(/^first: the turn ended in an error \(error_max_budget_usd\)$/, { text: 'Writing the recipe.', cost: 0.41, tools: [] }),
  );
  // a failure inside the run comes as the result: not signed in, the API refused
  const refused = fake([[{ type: 'result', subtype: 'success', is_error: true, result: 'Not signed in.', total_cost_usd: 0 }]]);
  await assert.rejects(
    runSession({ ...refused.opts, label: 'first', prompt: 'go' }),
    failure(/^first: the turn ended in an error \(success\)$/, { text: 'Not signed in.', cost: 0, tools: [] }),
  );
  // the process goes away in the middle of a turn, here the second one of a held session
  const early = fake([[], [says('About to stop.'), { type: 'fake', exit: 3 }]]);
  const s = await openSession({ ...early.opts, label: 'A' });
  await s.send('one');
  await assert.rejects(s.send('two'), failure(/^A: the session exited \(code 3\) before it answered$/, { text: 'About to stop.', cost: 0, tools: [] }));
  await s.close();
  assert.equal(pidAlive(early.log()[0].pid), false);
  // a command that is not there: the shell says so on Windows, the spawn fails elsewhere
  await assert.rejects(
    runSession({ ...fake().opts, command: ['agentboard-no-such-command'], label: 'first', prompt: 'go' }),
    failure(/^first: (could not be started \(.*ENOENT.*\)|the session exited \(code [1-9]\d*\) before it answered)$/, { text: '', cost: 0, tools: [] }),
  );
});

test('a session that does not answer within the time limit is killed', async () => {
  const f = fake([[says('Still thinking.'), { type: 'fake', hang: true }]]);
  await assert.rejects(runSession({ ...f.opts, label: 'B', prompt: 'go', timeoutMs: 3000 }), (err) => {
    assert.equal(err.name, 'SessionError');
    assert.equal(err.message, 'B: no answer within 3 s; the session was stopped');
    assert.equal(err.turn.text, 'Still thinking.');
    return true;
  });
  // the session itself is gone, not only the shell that started it on Windows
  assert.equal(pidAlive(f.log()[0].pid), false);
  assert.equal(f.opts.run.open.size, 0);
});

test('one run starts at most five sessions', async () => {
  assert.equal(MAX_SESSIONS, 5);
  const f = fake();
  assert.equal(f.opts.run.max, 5);
  await Promise.all(['first', 'second', 'A', 'B', 'C'].map((label) => runSession({ ...f.opts, label, prompt: 'go' })));
  const limit = /^Error: acceptance: refusing to start sixth: this run has started 5 sessions, and 5 is the limit$/;
  await assert.rejects(runSession({ ...f.opts, label: 'sixth', prompt: 'go' }), limit);
  await assert.rejects(openSession({ ...f.opts, label: 'sixth' }), limit);
  assert.equal(f.log().filter((entry) => entry.args).length, 5);
});

test('without a stand-in for claude, a test run starts nothing', { skip: !process.env.NODE_TEST_CONTEXT && 'needs node --test' }, async () => {
  const f = fake();
  // and should that refusal ever break: with no PATH, no `claude` is found
  await assert.rejects(runSession({ ...f.opts, env: plainEnv('PATH'), command: undefined, prompt: 'go' }), /a test run never starts a real session/);
  assert.equal(f.opts.run.started, 0);
});

// ---------------------------------------------------------------------------------------------
// The checks, on boards built with the real hooks and tools
// ---------------------------------------------------------------------------------------------

/** A project like the script's: a git repository with README.md and recipes.md. */
function project() {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# recipes-app\n');
  fs.writeFileSync(path.join(repo, 'recipes.md'), '# Recipes\n');
  return repo;
}

/** The project's files by name, as the script gives them to the checks. */
function filesOf(repo) {
  const names = ['README.md', 'recipes.md', 'shopping.md'].filter((name) => fs.existsSync(path.join(repo, name)));
  return Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(repo, name), 'utf8')]));
}

/** What a run printed as the checks' lines: 'ok', or the detail of a failed check. */
const verdicts = (checks) => checks.map((c) => (c.ok ? 'ok' : c.detail));

test('checkSolo passes on the board a good run leaves, and names what is missing otherwise', () => {
  // nothing happened
  const empty = project();
  const solo = (repo) => checkSolo({ board: openBoard(repo), turns: {}, files: filesOf(repo) });
  assert.deepEqual(verdicts(solo(empty)), [
    '#1 does not exist; #2 does not exist', 'nobody claimed #2', '#2 does not exist', '#1 does not exist; #2 does not exist', 'ok',
  ]);

  // only the first session ran
  const repo = project();
  const first = good.soloFirst({ cwd: repo, sessionId: 'solo-first', pid: process.pid, prompt: PROMPTS.soloFirst });
  assert.deepEqual(verdicts(solo(repo)), ['#2 is In progress', '#2 was not completed', '1 of its 2 items are done', 'ok', 'ok']);

  // the good run: the second session inherits #2 and completes it
  const second = good.soloSecond({ cwd: repo, sessionId: 'solo-second', pid: process.pid, prompt: PROMPTS.soloSecond });
  const checks = checkSolo({ board: openBoard(repo), turns: { first: [readTurn(first)], second: [readTurn(second)] }, files: filesOf(repo) });
  assert.deepEqual(checks.map((c) => c.name), [
    'tasks #1 and #2 were requested by the human and are Done with a summary',
    '#2 was claimed in the first session and completed by another, with no release in between (the claim was inherited)',
    '#2 has a checklist of at least two items, all done',
    'each task lists the files it touched, and they hold the work',
    'the board logged no internal error and no malformed line',
  ]);
  assert.deepEqual(checks.map((c) => [c.ok, c.detail]), Array(5).fill([true, '']));
  assert.equal(readTurn(second).tools.some((c) => boardTool(c.name) === 'claim_task'), false); // inherited, not claimed again
  // a table of contents is a heading that says so, or links to the headings
  const work = (readme) => verdicts(checkSolo({ board: openBoard(repo), files: { ...filesOf(repo), 'README.md': readme } }))[3];
  assert.equal(work('# recipes-app\n\n- [Recipes](#recipes)\n'), 'ok');
  assert.equal(work('# recipes-app\n'), 'README.md has no table of contents');

  // the board broke: an internal error was logged, and a line of the log is not an event
  const board = openBoard(repo);
  fs.writeFileSync(board.files.errors, 'an error\n');
  fs.appendFileSync(board.files.events, 'not an event\n');
  const [, , , , health] = solo(repo);
  assert.equal(health.ok, false);
  assert.equal(health.detail, `the board wrote an errors.log (${board.files.errors}); events.jsonl has 1 malformed line`);

  // the second session gives #2 back and takes it again, leaves a short checklist, and loses the recipe and the README
  const other = project();
  good.soloFirst({ cwd: other, sessionId: 'solo-first', pid: process.pid, prompt: PROMPTS.soloFirst });
  const s = pretendSession(other, { sessionId: 'solo-second' });
  s.start();
  s.board('release_task', { id: 2, note: 'Stopping here.' });
  s.board('claim_task', { id: 2 });
  s.board('update_task', { id: 2, checklist: [{ text: 'Everything', done: true }] });
  s.write('recipes.md', '# Recipes\n');
  s.board('complete_task', { id: 2, summary: 'Done.' });
  fs.rmSync(path.join(other, 'README.md'));
  assert.deepEqual(verdicts(solo(other)), [
    'ok',
    '#2 was released (manual) between its first claim and its completion',
    'its checklist has 1 item',
    'recipes.md does not mention a pancake; #2 lists README.md, which does not exist',
    'ok',
  ]);

  // one session does it all: a suggestion instead of the human's task, no checklist, no file
  const alone = project();
  const a = pretendSession(alone, { sessionId: 'solo-first' });
  a.start();
  a.board('create_task', { title: 'Add a pancake recipe to recipes.md', requestedByHuman: false });
  a.board('create_task', { title: 'Add a table of contents to README.md', requestedByHuman: true });
  a.board('claim_task', { id: 2 });
  a.board('complete_task', { id: 2, summary: 'Done.' });
  assert.deepEqual(verdicts(solo(alone)), [
    "#1 is an agent's suggestion, not a request of the human",
    'the session that first claimed #2 also completed it',
    'its checklist has 0 items',
    '#1 lists no touched file; #2 lists no touched file',
    'ok',
  ]);
});

test('checkPair passes on the board a good run leaves, and names what is missing otherwise', () => {
  const pair = (repo, turns, files = filesOf(repo)) => checkPair({ board: openBoard(repo), turns, files });
  // nothing happened
  assert.deepEqual(verdicts(pair(project(), {})), [
    '#2 does not exist',
    'session B made no claim_task call in its first turn',
    'nobody put #1 on the board, so there is no first agent to name',
    '#1 has no question to the human (its messages: none)',
    '#1 does not exist',
    'ok',
  ]);

  // the good run. A lives while B and C run, so they need another host process: this one's parent
  const repo = project();
  const a = { cwd: repo, sessionId: 'pair-a', pid: process.pid };
  const others = { cwd: repo, pid: process.ppid };
  const asked = good.pairAsk({ ...a, prompt: PROMPTS.pairAsk });
  const b = good.pairRefused({ ...others, sessionId: 'pair-b', prompt: PROMPTS.pairRefused });
  const answered = good.pairAnswer({ ...a, prompt: PROMPTS.pairAnswer });
  const c = good.pairShopping({ ...others, sessionId: 'pair-c', prompt: PROMPTS.pairShopping });
  const turns = { A: [readTurn(asked), readTurn(answered)], B: [readTurn(b)], C: [readTurn(c)] };
  const checks = pair(repo, turns);
  assert.deepEqual(checks.map((check) => check.name), [
    '#2 depends on #1',
    "the second agent's claim of #2 was refused while #1 was open",
    "the second agent's edit of recipes.md was refused, the refusal names the first agent, and its line is not in the file",
    '#1 has a question to the human and an answer relayed from the human',
    '#1 is Done by the first agent; #2 was claimed after that and is Done by another agent',
    'the board logged no internal error and no malformed line',
  ]);
  assert.deepEqual(checks.map((check) => [check.ok, check.detail]), Array(6).fill([true, '']));
  // what the board and the lock really said to B
  const [claim, edit] = turns.B[0].tools;
  assert.deepEqual([claim.isError, claim.output], [true, '#2 waits on #1. Pick a Ready task instead.']);
  assert.equal(edit.isError, true);
  assert.match(edit.output, /^recipes\.md is being edited by Amber on #1\. /);
  assert.equal(fs.readFileSync(path.join(repo, 'recipes.md'), 'utf8').includes(REFUSED_LINE), false);

  // the board's tools under the name they have when the plugin starts the server
  const renamed = (turn) => ({ ...turn, tools: turn.tools.map((t) => ({ ...t, name: t.name.replace('mcp__agentboard__', 'mcp__plugin_agentboard_agentboard__') })) });
  assert.equal(boardTool(renamed(turns.B[0]).tools[0].name), 'claim_task');
  assert.deepEqual(verdicts(pair(repo, { ...turns, B: turns.B.map(renamed) })), Array(6).fill('ok'));

  // a refusal (of an Edit this time) that names nobody, and the refused line in the file after all
  const [claimed, refusedEdit] = turns.B[0].tools;
  const vague = { ...turns, B: [{ ...turns.B[0], tools: [claimed, { ...refusedEdit, name: 'Edit', output: 'Permission denied.' }] }] };
  assert.equal(verdicts(pair(repo, vague))[2], 'the refusal does not name Amber: Permission denied.');
  assert.equal(verdicts(pair(repo, turns, { 'recipes.md': `# Recipes\n${REFUSED_LINE}\n` }))[2], 'recipes.md holds the refused line');

  // no dependency, a question to anyone, and B comes when A is gone: nothing is refused
  const late = project();
  const first = pretendSession(late, { sessionId: 'late-a' });
  first.start();
  first.board('create_task', { title: 'Add an ingredients section to recipes.md', requestedByHuman: true });
  first.board('create_task', { title: 'Write shopping.md from the ingredients', requestedByHuman: true });
  first.board('claim_task', { id: 1 });
  first.write('recipes.md', '# Recipes\n\n## Ingredients\n');
  first.board('post_message', { taskId: 1, kind: 'question', to: 'any', text: 'Metric or imperial units?' });
  first.board('complete_task', { id: 1, summary: 'Added the heading.' });
  first.end();
  const second = pretendSession(late, { sessionId: 'late-b', pid: process.ppid });
  second.start();
  second.board('claim_task', { id: 2 });
  second.write('recipes.md', `# Recipes\n\n## Ingredients\n\n${REFUSED_LINE}\n`);
  second.board('complete_task', { id: 2, summary: 'Wrote the list.' });
  const lateChecks = verdicts(pair(late, { B: [readTurn(second.take())] }));
  assert.equal(lateChecks[0], '#2 depends on nothing');
  assert.match(lateChecks[1], /^claim_task answered: You now hold #2\. .{1,110}\.\.\.$/);
  assert.equal(lateChecks[2], 'its edit of recipes.md was not refused');
  assert.match(lateChecks[3], /^#1 has no question to the human \(its messages: question, /);
  assert.deepEqual(lateChecks.slice(4), ['ok', 'ok']);

  // one agent does both tasks, and completes #1 without the human's answer; B only reads
  const alone = project();
  const only = pretendSession(alone, { sessionId: 'only-one' });
  only.start();
  only.board('create_task', { title: 'Add an ingredients section to recipes.md', requestedByHuman: true });
  only.board('create_task', { title: 'Write shopping.md from the ingredients', dependsOn: [1], requestedByHuman: true });
  only.board('claim_task', { id: 1 });
  only.board('post_message', { taskId: 1, kind: 'question', to: 'human', text: 'Metric or imperial units?' });
  only.board('complete_task', { id: 1, summary: 'Added the heading.' });
  only.board('claim_task', { id: 2 });
  only.board('complete_task', { id: 2, summary: 'Wrote the list.' });
  const reader = { text: 'done', cost: 0, tools: [{ name: 'Read', input: { file_path: 'recipes.md' }, output: '# Recipes', isError: false }] };
  const aloneChecks = verdicts(pair(alone, { B: [reader] }));
  assert.deepEqual(aloneChecks.slice(0, 3), ['ok', 'session B made no claim_task call in its first turn', 'session B made no Edit or Write call on recipes.md']);
  assert.match(aloneChecks[3], /^question m\d+ has no answer$/);
  assert.deepEqual(aloneChecks.slice(4), ['#2 was completed by Amber (only-one) too, not by another agent', 'ok']);
});

// ---------------------------------------------------------------------------------------------
// The script, against the stand-in
// ---------------------------------------------------------------------------------------------

/** A FAKE_CLAUDE_SCRIPT entry that does what a good session does for that prompt, with the real hooks and tools. */
const goodTurn = (name) => [{ type: 'fake', call: `${STEPS}#${name}` }];
/** Every prompt of the script answered by a good session. */
const GOOD = Object.fromEntries(Object.entries(PROMPTS).map(([name, prompt]) => [prompt, goodTurn(name)]));

/**
 * Runs the script with the stand-in in place of `claude`. Its temp folders are made in `tmp`.
 * Returns its exit status and output (times replaced by N), what the stand-in recorded, and `tmp`.
 */
function runScript(args, script, extraEnv = {}) {
  const tmp = tempDir();
  const logFile = path.join(tempDir(), 'fake.log');
  const env = {
    ...plainEnv('TMPDIR', 'TEMP', 'TMP'), TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    AGENTBOARD_ACCEPTANCE_CLAUDE: JSON.stringify(COMMAND), FAKE_CLAUDE_SCRIPT: JSON.stringify(script), FAKE_CLAUDE_LOG: logFile, ...extraEnv,
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
  const lines = r.stdout.replace(/after \d+ s/g, 'after N s').split('\n');
  return { status: r.status, stderr: r.stderr, lines, log: readLog(logFile), tmp };
}

const STAND_IN = 'AGENTBOARD_ACCEPTANCE_CLAUDE replaces the claude command: no real session starts.';
const SOLO_OK = [
  '  ok      tasks #1 and #2 were requested by the human and are Done with a summary',
  '  ok      #2 was claimed in the first session and completed by another, with no release in between (the claim was inherited)',
  '  ok      #2 has a checklist of at least two items, all done',
  '  ok      each task lists the files it touched, and they hold the work',
  '  ok      the board logged no internal error and no malformed line',
];

test('the script runs both scenarios in five sessions, prints a line per session and per check, and removes its folders', () => {
  // run from inside a Claude Code session, whose variables must not reach the sessions it starts
  const outer = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer-session', CLAUDE_PROJECT_DIR: ROOT, CLAUDE_CONFIG_DIR: tempDir() };
  const r = runScript(['all'], GOOD, outer);
  assert.deepEqual(r.lines, [
    STAND_IN,
    'solo: one agent, two sessions (model haiku, up to $0.4000 a session)',
    '  first: started',
    '  first: ended after N s, $0.0100',
    '  second: started',
    '  second: ended after N s, $0.0100',
    ...SOLO_OK,
    'pair: two agents in parallel (model haiku, up to $0.4000 a session)',
    '  A: started, stays open',
    '  A: turn 1 answered after N s, $0.0100 so far',
    '  B: started',
    '  B: ended after N s, $0.0100',
    '  A: turn 2 answered after N s, $0.0200 so far',
    '  C: started',
    '  C: ended after N s, $0.0100',
    '  A: ended after N s, $0.0200',
    '  ok      #2 depends on #1',
    "  ok      the second agent's claim of #2 was refused while #1 was open",
    "  ok      the second agent's edit of recipes.md was refused, the refusal names the first agent, and its line is not in the file",
    '  ok      #1 has a question to the human and an answer relayed from the human',
    '  ok      #1 is Done by the first agent; #2 was claimed after that and is Done by another agent',
    '  ok      the board logged no internal error and no malformed line',
    'sessions: 5 of at most 5, total cost $0.0600',
    'verdict: passed',
    '',
  ]);
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.deepEqual(fs.readdirSync(r.tmp), []);

  // five processes, each in its own recipes-app, and the prompts in the scenarios' order, none on a command line
  const starts = r.log.filter((entry) => entry.args);
  assert.equal(new Set(starts.map((s) => s.pid)).size, 5);
  assert.deepEqual(r.log.filter((entry) => entry.prompt).map((entry) => entry.prompt), Object.values(PROMPTS));
  for (const s of starts) {
    assert.equal(path.basename(s.cwd), 'recipes-app');
    // the MCP config is next to the project, not in it
    const mcpConfig = s.args[s.args.indexOf('--mcp-config') + 1];
    assert.equal(mcpConfig.toLowerCase(), path.join(path.dirname(s.cwd), 'mcp.json').toLowerCase());
    assert.deepEqual(s.args, claudeArgs({ pluginDir: ROOT, mcpConfig, model: 'haiku', budgetUsd: 0.4, held: s.args.includes('--input-format') }));
    assert.deepEqual(s.claudeEnv, ['CLAUDE_CONFIG_DIR']);
    assert.equal(pidAlive(s.pid), false);
  }
  assert.equal(starts.filter((s) => s.args.includes('--input-format')).length, 1); // only A is held
});

test('the script exits 1, names what each failed check found, and keeps the project and the transcripts', () => {
  // sessions that do nothing
  const r = runScript(['solo', '--model', 'sonnet', '--budget', '0.25'], {});
  const [folder] = fs.readdirSync(r.tmp);
  const kept = path.join(r.tmp, folder);
  assert.deepEqual(r.lines, [
    STAND_IN,
    'solo: one agent, two sessions (model sonnet, up to $0.2500 a session)',
    '  first: started',
    '  first: ended after N s, $0.0100',
    '  second: started',
    '  second: ended after N s, $0.0100',
    '  FAILED  tasks #1 and #2 were requested by the human and are Done with a summary: #1 does not exist; #2 does not exist',
    '  FAILED  #2 was claimed in the first session and completed by another, with no release in between (the claim was inherited): nobody claimed #2',
    '  FAILED  #2 has a checklist of at least two items, all done: #2 does not exist',
    '  FAILED  each task lists the files it touched, and they hold the work: #1 does not exist; #2 does not exist',
    SOLO_OK[4],
    'sessions: 2 of at most 5, total cost $0.0200',
    `kept: ${kept} (the project, and a transcript per session)`,
    'verdict: FAILED (4 problems)',
    '',
  ]);
  assert.deepEqual([r.status, r.stderr], [1, '']);
  assert.match(folder, /^agentboard-acceptance-/);
  assert.deepEqual(fs.readdirSync(kept).sort(), ['first.jsonl', 'gitconfig', 'mcp.json', 'no-hooks', 'recipes-app', 'second.jsonl']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(kept, 'mcp.json'), 'utf8')), mcpConfigOf(ROOT));
  assert.equal(JSON.parse(fs.readFileSync(path.join(kept, 'first.jsonl'), 'utf8').split('\n')[0]).subtype, 'init');
  // the project: two files in one commit, with its own identity and no hooks of the user's
  const project = path.join(kept, 'recipes-app');
  const text = (name) => fs.readFileSync(path.join(project, name), 'utf8');
  assert.deepEqual([text('README.md'), text('recipes.md')], ['# recipes-app\n', '# Recipes\n']);
  const git = (...args) => spawnSync('git', args, { cwd: project, env: gitEnv(), encoding: 'utf8' }).stdout;
  assert.equal(git('log', '--format=%ae %s'), 'recipes@example.invalid init\n');
  assert.equal(git('status', '--porcelain'), '');
  const config = fs.readFileSync(path.join(project, '.git', 'config'), 'utf8');
  assert.match(config, /email = recipes@example\.invalid/);
  assert.match(config, /hooksPath = .*no-hooks/);
  assert.deepEqual(fs.readdirSync(path.join(kept, 'no-hooks')), []);
  // the model and the budget reached every session
  for (const s of r.log.filter((entry) => entry.args)) {
    assert.deepEqual([s.args[s.args.indexOf('--model') + 1], s.args[s.args.indexOf('--max-budget-usd') + 1]], ['sonnet', '0.25']);
  }
});

test('--keep keeps the folder of a scenario that passed', () => {
  const r = runScript(['solo', '--keep'], GOOD);
  const [folder] = fs.readdirSync(r.tmp);
  assert.deepEqual(r.lines.slice(6), [
    ...SOLO_OK,
    'sessions: 2 of at most 5, total cost $0.0200',
    `kept: ${path.join(r.tmp, folder)} (the project, and a transcript per session)`,
    'verdict: passed',
    '',
  ]);
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(path.join(r.tmp, folder, 'recipes-app', 'recipes.md'), 'utf8'), /pancake/);
});

test('when a session fails, the script starts no other, closes the ones it opened and exits 1', () => {
  // B's process goes away before it answers, while A is open
  const r = runScript(['pair'], { [PROMPTS.pairAsk]: goodTurn('pairAsk'), [PROMPTS.pairRefused]: [{ type: 'fake', exit: 3 }] });
  const [folder] = fs.readdirSync(r.tmp);
  assert.deepEqual(r.lines, [
    STAND_IN,
    'pair: two agents in parallel (model haiku, up to $0.4000 a session)',
    '  A: started, stays open',
    '  A: turn 1 answered after N s, $0.0100 so far',
    '  B: started',
    '  B: failed after N s',
    '  A: ended after N s, $0.0100',
    '  FAILED  session B: the session exited (code 3) before it answered',
    'sessions: 2 of at most 5, total cost $0.0100',
    `kept: ${path.join(r.tmp, folder)} (the project, and a transcript per session)`,
    'verdict: FAILED (1 problem)',
    '',
  ]);
  assert.deepEqual([r.status, r.stderr], [1, '']);
  assert.deepEqual(r.log.filter((entry) => entry.prompt).map((entry) => entry.prompt), [PROMPTS.pairAsk, PROMPTS.pairRefused]);
  for (const s of r.log.filter((entry) => entry.args)) assert.equal(pidAlive(s.pid), false);
});

test('the script refuses arguments it does not know, and a stand-in it cannot read, before any session starts', () => {
  for (const args of [['both'], ['solo', 'pair'], ['--budget', 'free'], ['--budget', '0'], ['--model'], ['--model', 'two words'], ['--verbose']]) {
    const r = runScript(args, GOOD);
    assert.deepEqual([r.status, r.stderr, r.lines, r.log], [1, USAGE, [''], []], args.join(' '));
    assert.deepEqual(fs.readdirSync(r.tmp), []);
  }
  const help = runScript(['--help'], GOOD);
  assert.deepEqual([help.status, help.lines, help.log], [0, [USAGE.trimEnd(), ''], []]);
  // a stand-in that is not a JSON array is an error, never a reason to run the real command
  const r = runScript(['solo'], GOOD, { AGENTBOARD_ACCEPTANCE_CLAUDE: 'node fake-claude.mjs' });
  assert.deepEqual(r.lines, [
    '  FAILED  acceptance: AGENTBOARD_ACCEPTANCE_CLAUDE must be a JSON array of texts, such as ["node","test/fixtures/fake-claude.mjs"]',
    'sessions: 0 of at most 5, total cost $0.0000',
    'verdict: FAILED (1 problem)',
    '',
  ]);
  assert.deepEqual([r.status, r.log], [1, []]);
});
