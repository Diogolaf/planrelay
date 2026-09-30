import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv, tempDir, tempRepo } from './helpers.js';

const CLI = path.resolve('src/cli.js');

/** The environment of a child process: no session variables inherited from a Claude Code session running the tests. */
function childEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !k.toUpperCase().startsWith('CLAUDE')));
  return { ...env, ...extra };
}

/** A folder outside git, with its own home folder, so its board is created in a temp home and never in the real one. */
function nonGitProject() {
  const project = path.join(tempDir(), 'recipes app');
  fs.mkdirSync(project);
  const home = tempDir();
  return { project, home, env: { HOME: home, USERPROFILE: home, GIT_CEILING_DIRECTORIES: path.dirname(project) } };
}

const runCli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv(), ...opts });
const hook = (input, env = {}) => runCli(['hook'], { input, env: childEnv({ CLAUDE_PID: String(process.pid), ...env }) });

async function waitFor(check, timeoutMs = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A running `agentboard mcp` process: send JSON-RPC messages, read its answers, close its input. */
function mcp(env) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: childEnv(env) });
  const lines = [];
  let buf = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    buf += c.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    lines, send, stderr: () => stderr,
    /** The answer to request `id`, once it arrives. */
    answer: async (id) => {
      await waitFor(() => lines.some((l) => l.id === id));
      return lines.find((l) => l.id === id);
    },
    /** Closes the server's input, as the host does at the end of a session, and waits for it to exit. */
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('hook: reads JSON on stdin and prints the hook output', () => {
  const repo = tempRepo();
  const r = hook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: repo }));
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you are agent Amber/);
});

test('hook: input it cannot use exits 0 with no output, so a hook never blocks the agent', () => {
  const repo = tempRepo();
  const inputs = [
    'nope', '', '{"hook_event_name":', 'null', '[1,2]', '"SessionStart"',
    // a newer host: an event this version does not handle, and known events with fields in a new shape
    JSON.stringify({ hook_event_name: 'PostToolBatch', session_id: 's1', cwd: repo }),
    JSON.stringify({ hook_event_name: 'SessionStart', session_id: { id: 's1' }, cwd: repo }),
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Edit', tool_input: 'a.js' }),
    JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: repo, tool_name: 'TodoWrite', tool_input: { todos: 'x' } }),
  ];
  for (const input of inputs) {
    const r = hook(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
    assert.equal(r.stderr, '', input);
  }
});

test('hook: JSON that starts with a byte order mark is read', () => {
  const repo = tempRepo();
  const bom = String.fromCharCode(0xfeff);
  const r = hook(bom + JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: repo }));
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you are agent Amber/);
});

test('hook: a project outside git gets its board in the home folder, with spaces in the path', () => {
  const { project, home, env } = nonGitProject();
  const r = hook(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: project }), { ...env, CLAUDE_PROJECT_DIR: project });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you are agent Amber[\s\S]*Project: recipes app/);
  assert.equal(fs.readdirSync(path.join(home, '.agentboard', 'boards')).length, 1);
});

test('mcp: answers initialize and tools/list over stdio, and exits when its input closes', async () => {
  const repo = tempRepo();
  const s = mcp({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const init = await s.answer(1);
  const list = await s.answer(2);
  assert.equal(init.result.serverInfo.name, 'agentboard');
  assert.equal(list.result.tools.length, 9);
  assert.equal(await s.close(), 0);
  assert.equal(s.lines.length, 2);
  assert.equal(s.stderr(), '');
});

test('mcp: works in a project outside git', async () => {
  const { project, env } = nonGitProject();
  const s = mcp({ ...env, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send(call(2, 'create_task', { title: 'Add a README', requestedByHuman: true }));
  assert.deepEqual((await s.answer(2)).result.content, [{ type: 'text', text: 'Created #1 — Ready.' }]);
  s.send(call(3, 'list_tasks', {}));
  assert.match((await s.answer(3)).result.content[0].text, /#1 Add a README — Ready/);
  assert.equal(await s.close(), 0);
});

test('repair: rebuilds and reports', () => {
  const r = runCli(['repair'], { cwd: tempRepo() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^agentboard: rebuilt 0 tasks from 0 events \(board: .+\)\.\n$/);
});

test('repair: counts what it rebuilt and names skipped lines', async () => {
  const repo = tempRepo();
  const s = mcp({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send(call(2, 'create_task', { title: 'Add a README', requestedByHuman: true }));
  await s.answer(2);
  await s.close();
  fs.appendFileSync(path.join(repo, '.git', 'agentboard', 'events.jsonl'), 'not json\n');
  const r = runCli(['repair'], { cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^agentboard: rebuilt 1 task from 1 event \(board: .+\); skipped malformed line 2\.\n$/);
});

test('repair: a failure is one readable line and exit code 1', () => {
  const repo = tempRepo();
  // the board folder is a file: nothing can be written there
  fs.writeFileSync(path.join(repo, '.git', 'agentboard'), '');
  const r = runCli(['repair'], { cwd: repo });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^agentboard: repair failed: .+\n$/);
});

test('unknown command prints usage and exits 1; help prints it and exits 0', () => {
  for (const args of [['dance'], []]) {
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: agentboard <hook\|mcp\|repair>/);
  }
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: agentboard <hook\|mcp\|repair>/);
});
