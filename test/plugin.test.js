import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../src/core/config.js';
import { openBoard } from '../src/core/store.js';
import { EDIT_TOOLS } from '../src/hooks/run.js';
import { buildTools } from '../src/mcp/tools.js';
import { NAME } from '../src/name.js';
import { gitEnv, tempDir, tempRepo } from './helpers.js';

// The plugin files follow the Claude Code plugin reference (code.claude.com/docs/en/plugins-reference):
// hooks and the MCP server run in exec form (`command` plus `args`), so a plugin folder with spaces
// in its path needs no quoting.

const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ROOT = '${CLAUDE_PLUGIN_ROOT}';
const ENTRY = `${ROOT}/src/cli.js`;
const SKILL = `skills/${NAME}/SKILL.md`;

/** The environment of a child process: no session variables inherited from a Claude Code session running the tests. */
const childEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !k.toUpperCase().startsWith('CLAUDE'))),
  ...extra,
});

/**
 * A copy of the plugin in a folder with spaces in its path, and a command from its files run the
 * way Claude Code runs exec-form commands: no shell, `${CLAUDE_PLUGIN_ROOT}` replaced in every
 * argument, with forward slashes on Windows.
 */
function installedPlugin() {
  const root = path.join(tempDir(), 'Plugin Root', NAME);
  for (const p of ['src', 'hooks', 'skills', '.claude-plugin', '.mcp.json', 'package.json']) fs.cpSync(p, path.join(root, p), { recursive: true });
  const rootVar = root.split(path.sep).join('/');
  /** Spawn arguments for a { command, args } entry of the installed plugin. */
  const argv = ({ command, args }) => {
    assert.equal(command, 'node');
    return [process.execPath, args.map((a) => a.replaceAll(ROOT, rootVar))];
  };
  return { root, argv };
}

test('plugin manifest', () => {
  const m = json('.claude-plugin/plugin.json');
  assert.equal(m.name, NAME);
  assert.equal(m.version, json('package.json').version);
  assert.equal(m.license, json('package.json').license);
  assert.equal(typeof m.description, 'string');
  // components live at their default locations at the plugin root, never inside .claude-plugin/
  assert.deepEqual(fs.readdirSync('.claude-plugin'), ['plugin.json']);
  for (const key of ['hooks', 'mcpServers', 'skills', 'commands', 'agents']) assert.equal(m[key], undefined, key);
});

test('every hook event runs the CLI hook entry point in exec form', () => {
  const { hooks } = json('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
  for (const [event, groups] of Object.entries(hooks)) {
    assert.equal(groups.length, 1, event);
    for (const h of groups[0].hooks) {
      assert.deepEqual(h, { type: 'command', command: 'node', args: [ENTRY, 'hook'], timeout: 10 }, event);
    }
  }
  // SessionStart and SessionEnd run for every source and reason (startup, resume, clear, compact...)
  assert.equal(hooks.SessionStart[0].matcher, undefined);
  assert.equal(hooks.SessionEnd[0].matcher, undefined);
  // the tools run.js handles: the file-editing tools, and TodoWrite after the fact
  assert.deepEqual(hooks.PreToolUse[0].matcher.split('|').sort(), [...EDIT_TOOLS].sort());
  assert.deepEqual(hooks.PostToolUse[0].matcher.split('|').sort(), [...EDIT_TOOLS, 'TodoWrite'].sort());
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
});

test('MCP server registration', () => {
  const server = json('.mcp.json').mcpServers[NAME];
  assert.deepEqual(server, { command: 'node', args: [ENTRY, 'mcp'] });
});

test('the installed plugin runs from a folder with spaces in its path', async () => {
  const { argv } = installedPlugin();
  const repo = tempRepo();
  const env = childEnv({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: String(process.pid) });

  const [node, args] = argv(json('hooks/hooks.json').hooks.SessionStart[0].hooks[0]);
  const r = spawnSync(node, args, {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: repo, source: 'startup' }), encoding: 'utf8', env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you are agent Amber/);

  const [mcpNode, mcpArgs] = argv(json('.mcp.json').mcpServers[NAME]);
  const child = spawn(mcpNode, mcpArgs, { env, cwd: repo });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  child.stdin.end();
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(out).result.tools.length, 10);
});

test('skill front matter', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.match(text, new RegExp(`^---\\nname: ${NAME}\\ndescription: .+\\n---\\n`));
  // the description is listed in every session; the body stays in context once loaded
  const description = /^description: (.+)$/m.exec(text)[1];
  assert.ok(description.length < 400);
  // it triggers on board words, and "task" means a board task, not the host's own task tools
  for (const word of ['task', 'epic', 'backlog', 'board', 'what should I work on', 'handoff']) assert.ok(description.includes(word), word);
  assert.match(description, /"Task" means a task on this board \(create_task\), not TaskCreate or TodoWrite/);
  assert.doesNotMatch(description, /: /); // a plain YAML scalar
  assert.ok(text.length < 7000, `the skill is ${text.length} characters`);
});

test('the skill names only real tools, tool fields and config options', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  const tools = buildTools(openBoard(tempRepo()), { folder: '.' });
  const toolNames = new Set(tools.map((t) => t.name));
  const fields = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties)));
  const known = new Set([...fields, ...Object.keys(DEFAULTS)]);
  const snake = [...text.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
  const camel = [...text.matchAll(/`([a-z]+[A-Z]\w*)[`:]/g)].map((m) => m[1]);
  // every tool is covered, and nothing else in snake_case except the column name
  assert.deepEqual([...toolNames].filter((n) => !snake.includes(n)), []);
  assert.deepEqual(snake.filter((n) => !toolNames.has(n) && n !== 'in_progress'), []);
  assert.deepEqual(camel.filter((n) => !known.has(n)), []);
  // what the protocol depends on (plan must-dos)
  assert.match(text, /`takeOver: true`[^\n]*only[^\n]*human asked/);
  assert.match(text, /`update_task`[^\n]*`checklist`/);
  assert.match(text, /`relayedFromHuman: true`/);
  assert.match(text, /config problems/i);
  assert.match(text, /"open the board"[^\n]*"show me the board"[^\n]*`open_board`[^\n]*URL/);
});
