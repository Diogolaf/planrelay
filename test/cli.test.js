import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openBoard, readRegistry, readState } from '../src/core/store.js';
import { boardId } from '../src/dashboard/server.js';
import { NAME } from '../src/name.js';
import { buildRecipesBoard } from './fixtures/recipes-app.js';
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

/** Every `planrelay mcp` process started here. One a failed test left running is stopped at the end, so the run fails instead of hanging. */
const servers = [];
after(() => {
  for (const child of servers) child.kill();
});

/** A running `planrelay mcp` process: send JSON-RPC messages, read its answers, close its input. */
function mcp(env) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: childEnv(env) });
  servers.push(child);
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
  assert.equal(fs.readdirSync(path.join(home, '.planrelay', 'boards')).length, 1);
});

test('mcp: answers initialize and tools/list over stdio, and exits when its input closes', async () => {
  const repo = tempRepo();
  const s = mcp({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const init = await s.answer(1);
  const list = await s.answer(2);
  assert.equal(init.result.serverInfo.name, NAME);
  assert.equal(list.result.tools.length, 10);
  assert.equal(await s.close(), 0);
  assert.equal(s.lines.length, 2);
  assert.equal(s.stderr(), '');
});

test('hook: without CLAUDE_PID the host process of the agent is the parent of the hook', () => {
  const repo = tempRepo();
  const r = runCli(['hook'], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: repo }) });
  assert.equal(r.status, 0);
  assert.equal(readRegistry(openBoard(repo)).agents.s1.pid, process.pid);
});

test('mcp: Claude Code gives the server no CLAUDE_PID; acting for its parent process, it follows /clear to the new session', async () => {
  // This process plays Claude Code: the hooks get CLAUDE_PID = process.pid, the server is a direct child without it.
  const repo = tempRepo();
  const session = (event, id, extra = {}) => assert.equal(hook(JSON.stringify({ hook_event_name: event, session_id: id, cwd: repo, ...extra })).status, 0);
  session('SessionStart', 's1', { source: 'startup' });
  const s = mcp({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send(call(2, 'create_task', { title: 'Add a README', requestedByHuman: true }));
  assert.deepEqual((await s.answer(2)).result.content, [{ type: 'text', text: 'Created #1 — Ready.' }]);
  session('SessionEnd', 's1', { reason: 'clear' });
  session('SessionStart', 's2', { source: 'clear' });
  s.send(call(3, 'claim_task', { id: 1 }));
  assert.match((await s.answer(3)).result.content[0].text, /^You now hold #1\./);
  assert.equal(await s.close(), 0);
  const board = openBoard(repo);
  assert.equal(readState(board).tasks[1].assignee, 's2');
  const { agents } = readRegistry(board);
  assert.equal(agents.s2.pid, process.pid);
  assert.notEqual(agents.s1.endedAt, null);
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
  assert.match(r.stdout, /^planrelay: rebuilt 0 tasks from 0 events \(board: .+\)\.\n$/);
});

test('repair: counts what it rebuilt and names skipped lines', async () => {
  const repo = tempRepo();
  const s = mcp({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1' });
  s.send(call(2, 'create_task', { title: 'Add a README', requestedByHuman: true }));
  await s.answer(2);
  await s.close();
  fs.appendFileSync(path.join(repo, '.git', 'planrelay', 'events.jsonl'), 'not json\n');
  const r = runCli(['repair'], { cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^planrelay: rebuilt 1 task from 1 event \(board: .+\); skipped malformed line 2\.\n$/);
});

test('repair: a failure is one readable line and exit code 1', () => {
  const repo = tempRepo();
  // the board folder is a file: nothing can be written there
  fs.writeFileSync(path.join(repo, '.git', 'planrelay'), '');
  const r = runCli(['repair'], { cwd: repo });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^planrelay: repair failed: .+\n$/);
});

test('unknown command prints usage and exits 1; help prints it and exits 0', () => {
  for (const args of [['dance'], []]) {
    const r = runCli(args);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: planrelay <hook\|mcp\|repair\|dashboard>/);
  }
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: planrelay <hook\|mcp\|repair\|dashboard>/);
});

/** GET a path of a local server; resolves with the parsed JSON body. @param {number} port @param {string} reqPath */
function getJson(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
  });
}

test('dashboard: serves the board until stopped, records itself in dashboard.json, and a second start reuses it', async () => {
  const repo = tempRepo();
  const board = buildRecipesBoard(repo);
  const file = path.join(board.dir, 'dashboard.json');
  const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--port', '0', '--dir', repo], { env: childEnv() });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { err += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let url = '';
  try {
    await waitFor(() => out.includes('\n') || err !== '');
    const m = /^planrelay dashboard for (.+): (http:\/\/127\.0\.0\.1:(\d+)\/) \(Ctrl\+C to stop\)\n$/.exec(out);
    assert.ok(m, `stdout: ${out} stderr: ${err}`);
    assert.equal(m[1], board.projectName);
    url = m[2];
    const port = Number(m[3]);
    assert.deepEqual(await getJson(port, '/api/ping'), { app: 'planrelay', board: boardId(board) });
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual({ pid: rec.pid, port: rec.port, board: rec.board }, { pid: child.pid, port, board: boardId(board) });

    const again = runCli(['dashboard', '--no-open', '--dir', repo], { timeout: 10000 });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, `planrelay dashboard for ${board.projectName} is already running: ${url}\n`);
  } finally {
    child.kill('SIGINT');
  }
  const code = await exited;
  if (process.platform === 'win32') {
    // Windows has no signals: kill() ends the process at once, so its record stays, naming a dead
    // process, and the next start replaces it (launch.test.js). Ctrl+C in a terminal is a clean exit.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, child.pid);
  } else {
    assert.equal(code, 0, err);
    assert.equal(fs.existsSync(file), false);
  }
});

test('dashboard --idle-exit: with no browser connected, it stops by itself, cleanly, and removes dashboard.json', async () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  const file = path.join(board.dir, 'dashboard.json');
  // 0.01 minutes: 600 ms
  const child = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '--dir', repo, '--idle-exit', '0.01'], { env: childEnv() });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { err += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    await waitFor(() => out.includes('\n') || err !== '');
    assert.match(out, /^planrelay dashboard for .+: http:\/\/127\.0\.0\.1:\d+\/ \(Ctrl\+C to stop\)\n$/, err);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, child.pid);
    assert.equal(await exited, 0, err);
    assert.equal(fs.existsSync(file), false);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});

test('dashboard: a bad --port or --idle-exit, an unknown option or a folder that does not exist prints why and exits 1', () => {
  const usage = /^usage: planrelay dashboard \[--port N\] \[--dir PATH\] \[--no-open\] \[--idle-exit MINUTES\]\n$/;
  const bad = [
    ['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--port', '80.5'], ['--port'], ['--verbose'], ['extra'],
    ['--idle-exit', '0'], ['--idle-exit', 'soon'], ['--idle-exit', '-5'], ['--idle-exit', '99999'], ['--idle-exit'],
  ];
  for (const args of bad) {
    const r = runCli(['dashboard', '--no-open', ...args], { cwd: tempRepo(), timeout: 10000 });
    assert.equal(r.status, 1, args.join(' '));
    assert.match(r.stderr, usage, args.join(' '));
  }
  const missing = path.join(tempDir(), 'no such folder');
  const r = runCli(['dashboard', '--no-open', '--dir', missing], { timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^planrelay: dashboard failed: .*no such folder.* is not a folder\n$/);
});
