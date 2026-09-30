#!/usr/bin/env node
// A stand-in for the `claude` command, for the tests of the acceptance script. It starts no model
// and contacts nothing. Run as `node fake-claude.mjs <flags>`, it prints the stream-json of a
// headless session (code.claude.com/docs/en/headless):
// - first a `system` `init` line with a session id, the tools and the MCP servers of --mcp-config;
// - then, for each prompt it reads, that turn's lines and a `result` line. A prompt is the whole
//   of stdin, or with --input-format stream-json one JSON line per turn, until stdin closes.
//
// FAKE_CLAUDE_SCRIPT says what each turn prints. It is JSON: an array (turn n prints entry n), or
// an object (a turn prints the entry whose key is part of its prompt). An entry is a list of
// stream lines. A line of type "fake" is an instruction and is not printed:
//   { "type": "fake", "call": "<module file>#<export>" }  imports the module and calls the export
//       with { cwd, sessionId, pid, prompt }; the lines it returns are printed
//   { "type": "fake", "exit": 3 }     the process exits with that code, and the turn has no result
//   { "type": "fake", "hang": true }  the turn never ends: the process stays until it is stopped
// A `result` line in an entry takes the place of the usual one, whose cost grows by 0.01 a turn
// (a session reports its total so far).
//
// FAKE_CLAUDE_LOG names a file that gets one JSON line when the process starts ({ pid, args, cwd,
// claudeEnv: the names of its CLAUDE* variables }) and one per prompt ({ pid, prompt }).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const BOARD_TOOLS = [
  'whats_new', 'list_tasks', 'get_task', 'create_task', 'update_task', 'claim_task', 'post_message', 'complete_task', 'release_task', 'open_board',
];

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const held = flag('--input-format') === 'stream-json';
const sessionId = randomUUID();
const script = JSON.parse(process.env.FAKE_CLAUDE_SCRIPT || '[]');
const logFile = process.env.FAKE_CLAUDE_LOG;

const log = (entry) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

/** The servers of the --mcp-config file, as the init line lists them; none when the file cannot be read. */
function mcpServers() {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8')).mcpServers).map((name) => ({ name, status: 'connected' }));
  } catch {
    return [];
  }
}

let turns = 0;

/** Answers one prompt. Returns false when the process must end without reading further. */
async function turn(prompt) {
  log({ prompt });
  const entry = Array.isArray(script) ? script[turns] : Object.entries(script).find(([key]) => prompt.includes(key))?.[1];
  turns += 1;
  let ended = false;
  for (const line of entry ?? []) {
    if (line?.type !== 'fake') {
      print(line);
      ended ||= line?.type === 'result';
    } else if (line.call) {
      const at = line.call.lastIndexOf('#');
      const mod = await import(pathToFileURL(path.resolve(line.call.slice(0, at))).href);
      for (const made of await mod[line.call.slice(at + 1)]({ cwd: process.cwd(), sessionId, pid: process.pid, prompt })) print(made);
    } else if (line.exit !== undefined) {
      process.exitCode = line.exit;
      return false;
    } else if (line.hang) {
      setInterval(() => {}, 60_000); // keeps the process alive after its input has closed
      await new Promise(() => {});
    }
  }
  if (!ended) {
    print({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, result: 'done', session_id: sessionId,
      total_cost_usd: turns / 100, permission_denials: [],
    });
  }
  return true;
}

log({ args, cwd: process.cwd(), claudeEnv: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('CLAUDE')).sort() });
print({
  type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId, model: flag('--model'), permissionMode: flag('--permission-mode'),
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite', ...BOARD_TOOLS.map((name) => `mcp__planrelay__${name}`)],
  mcp_servers: mcpServers(),
});

if (held) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const content = JSON.parse(line).message.content;
    const prompt = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!(await turn(prompt))) break;
  }
  process.stdin.destroy();
} else {
  process.stdin.setEncoding('utf8');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  await turn(prompt);
}
