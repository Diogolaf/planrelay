import fs from 'node:fs';
import path from 'node:path';
import { REFUSED_LINE } from '../../scripts/lib/acceptance.mjs';
import { currentHost } from '../../src/core/agents.js';
import { openBoard, readState } from '../../src/core/store.js';
import { runHook } from '../../src/hooks/run.js';
import { buildTools } from '../../src/mcp/tools.js';
import { NAME } from '../../src/name.js';

/**
 * A pretend Claude Code session in `repo`, for the tests of the acceptance script: no model and no
 * child process. It calls the plugin's real hooks and board tools in this process, the way the
 * host calls them, and keeps the stream-json lines such a session prints for each tool call.
 * - Two sessions that live at the same time need different host processes (`pid`): one host
 *   process has one live agent.
 * - A board tool's reply is a list of text blocks, a built-in tool's a string, as in a real stream.
 * @param {string} repo
 * @param {{ sessionId: string, pid?: number, prefix?: string }} opts prefix: what the board's tools are called in this session
 */
export function pretendSession(repo, { sessionId, pid = process.pid, prefix = `mcp__${NAME}__` }) {
  const env = { CLAUDE_PID: String(pid) };
  const board = openBoard(repo);
  const tools = buildTools(board, { sessionId, pid, folder: board.repoRoot, host: currentHost(env) });
  const hook = (event, extra = {}) => runHook({ hook_event_name: event, session_id: sessionId, cwd: repo, ...extra }, { env });
  const said = (content) => ({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, message: { role: 'assistant', content } });
  /** @type {object[]} */
  let lines = [];
  let calls = 0;
  const record = (name, input, result) => {
    const id = `toolu_${sessionId.slice(0, 8)}_${++calls}`;
    lines.push(said([{ type: 'tool_use', id, name, input }]), {
      type: 'user', session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...result }] },
    });
  };
  return {
    /** SessionStart: registers the agent, which inherits a claim an ended session left in the folder. */
    start: () => hook('SessionStart', { source: 'startup' }),
    /** UserPromptSubmit. */
    prompt: (text) => hook('UserPromptSubmit', { prompt: text }),
    /** SessionEnd: the agent is gone; its claim stays with the folder. */
    end: () => hook('SessionEnd', { reason: 'other' }),
    /** A board tool call; a refusal is a result with is_error, as the MCP server answers it. Returns the reply. */
    board(name, input) {
      let text;
      let refused = false;
      try {
        text = tools.find((t) => t.name === name).handler(input);
      } catch (err) {
        if (err?.name !== 'BoardError') throw err;
        text = err.message;
        refused = true;
      }
      record(`${prefix}${name}`, input, { content: [{ type: 'text', text }], ...(refused ? { is_error: true } : {}) });
      return text;
    },
    /**
     * A Write of a project file: refused with the PreToolUse hook's reason when another agent's
     * lock covers it; otherwise written, and the PostToolUse hook records it. Returns true when written.
     */
    write(file, text) {
      const input = { file_path: path.join(repo, file), content: text };
      const out = hook('PreToolUse', { tool_name: 'Write', tool_input: input });
      const decision = out ? JSON.parse(out).hookSpecificOutput : null;
      if (decision?.permissionDecision === 'deny') {
        record('Write', input, { content: decision.permissionDecisionReason, is_error: true });
        return false;
      }
      fs.writeFileSync(input.file_path, text);
      hook('PostToolUse', { tool_name: 'Write', tool_input: input });
      record('Write', input, { content: `Wrote ${file}.`, is_error: false });
      return true;
    },
    /** A text the assistant writes. */
    say(text) {
      lines.push(said([{ type: 'text', text }]));
    },
    /** The lines printed since the last take(). */
    take() {
      const out = lines;
      lines = [];
      return out;
    },
  };
}

// What a good run of each scenario does, one function per prompt of the acceptance script
// (PROMPTS in scripts/lib/acceptance.mjs). Each takes { cwd, sessionId, pid, prompt } and returns
// the stream lines of that turn, so test/fixtures/fake-claude.mjs can call it
// ({ "type": "fake", "call": "<this file>#soloFirst" }) and a test can call it directly.

/** The sessions in progress, so the second prompt of a held session goes on with the first one's. */
const sessions = new Map();

/** The session of a turn, started at its first prompt. */
function sessionOf({ cwd, sessionId, pid, prompt }) {
  const key = `${cwd}\n${sessionId}`;
  if (!sessions.has(key)) {
    sessions.set(key, pretendSession(cwd, { sessionId, pid }));
    sessions.get(key).start();
  }
  sessions.get(key).prompt(prompt);
  return sessions.get(key);
}

/** Solo, first session: two tasks, the first done, the second claimed with half its checklist done. */
export function soloFirst(ctx) {
  const s = sessionOf(ctx);
  s.board('create_task', { title: 'Add a pancake recipe to recipes.md', requestedByHuman: true });
  s.board('create_task', { title: 'Add a table of contents to README.md', requestedByHuman: true });
  s.board('claim_task', { id: 1 });
  s.write('recipes.md', '# Recipes\n\n## Pancakes\n\nFlour, milk and eggs. Fry each pancake until golden.\n');
  s.board('complete_task', { id: 1, summary: 'Added a pancake recipe to recipes.md.' });
  s.board('claim_task', { id: 2 });
  s.board('update_task', { id: 2, checklist: [{ text: 'Add the heading', done: false }, { text: 'List the sections', done: false }] });
  s.write('README.md', '# recipes-app\n\n## Contents\n');
  s.board('update_task', { id: 2, checklist: [{ text: 'Add the heading', done: true }, { text: 'List the sections', done: false }] });
  s.say('The first task is done; the second waits for the next session.');
  s.end();
  return s.take();
}

/** Solo, second session: it inherits #2 at its start and completes it. */
export function soloSecond(ctx) {
  const s = sessionOf(ctx);
  s.board('get_task', { id: 2 });
  s.write('README.md', '# recipes-app\n\n## Contents\n\n- [Recipes](recipes.md)\n');
  s.board('update_task', { id: 2, checklist: [{ text: 'Add the heading', done: true }, { text: 'List the sections', done: true }] });
  s.board('complete_task', { id: 2, summary: 'README.md has a table of contents.' });
  s.say('The task is complete.');
  s.end();
  return s.take();
}

/** Pair, agent A, first prompt: two tasks, the second depending on the first, which it claims, edits and asks about. */
export function pairAsk(ctx) {
  const s = sessionOf(ctx);
  s.board('create_task', { title: 'Add an ingredients section to recipes.md', requestedByHuman: true });
  s.board('create_task', { title: 'Write shopping.md from the ingredients', dependsOn: [1], requestedByHuman: true });
  s.board('claim_task', { id: 1 });
  s.write('recipes.md', '# Recipes\n\n## Ingredients\n');
  s.board('post_message', { taskId: 1, kind: 'question', to: 'human', text: 'Metric or imperial units?' });
  s.say('Should the ingredients use metric or imperial units?');
  return s.take();
}

/** Pair, agent B, while A lives: the board refuses its claim, and the lock refuses its edit. */
export function pairRefused(ctx) {
  const s = sessionOf(ctx);
  s.board('claim_task', { id: 2 });
  s.write('recipes.md', `# Recipes\n\n## Ingredients\n\n${REFUSED_LINE}\n`);
  s.say('The board refused the claim and the edit.');
  s.end();
  return s.take();
}

/** Pair, agent A, second prompt: it records the human's answer and completes #1. */
export function pairAnswer(ctx) {
  const s = sessionOf(ctx);
  const [question] = readState(openBoard(ctx.cwd)).tasks[1].openQuestions;
  s.board('post_message', { taskId: 1, kind: 'answer', replyTo: question.id, relayedFromHuman: true, text: 'Metric.' });
  s.write('recipes.md', '# Recipes\n\n## Ingredients\n\n- 250 g flour\n- 500 ml milk\n');
  s.board('complete_task', { id: 1, summary: 'recipes.md lists the ingredients in metric units.' });
  s.say('The task is complete.');
  return s.take();
}

/** Pair, agent C, while A still lives: #2 is free now. */
export function pairShopping(ctx) {
  const s = sessionOf(ctx);
  s.board('claim_task', { id: 2 });
  s.write('shopping.md', '# Shopping\n\n- 250 g flour\n- 500 ml milk\n');
  s.board('complete_task', { id: 2, summary: 'Wrote shopping.md from the ingredients.' });
  s.say('The shopping list is written.');
  s.end();
  return s.take();
}
