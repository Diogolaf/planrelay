import { endAgent, getAgent, touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { claimTask, completeTask, createTask, postMessage, releaseTask, touchTaskFile, updateTask } from '../../src/core/ops.js';
import { openBoard, transact } from '../../src/core/store.js';

const MIN = 60_000;

/** Task ids of the fixture, for tests. Tasks are created in this order, so ids are stable. */
export const FIXTURE_IDS = Object.freeze({
  search: 1, filters: 2, accounts: 3,
  byIngredient: 4, vegetarian: 5, prepTime: 6, passwordReset: 7, rememberMe: 8, photoUpload: 9,
  favorites: 10, cachePhotos: 11, darkMode: 12, pagination: 13, rounding: 14,
});

/**
 * Builds the made-up "recipes-app" board of the mockups in `repo` (a git repository) through the
 * real operations: epics and a sub-epic, done work today, an agent in progress with a checklist and
 * a last edited file, a question to the human, a dependency, two agent suggestions, and a claim held
 * by a session that ended. Times run from 88 min before `now` to 2 min before it, never later, so
 * "Shipped today" is filled unless `now` is within 90 min after local midnight (the UI test skips
 * that one check then). The agents are Amber (holds #5), Jade (holds #6, asked the human) and Cobalt
 * (holds #9 with a handoff note; its session ended).
 * @param {string} repo @param {{ now?: number }} [opts]
 * @returns {import('../../src/core/store.js').Board}
 */
export function buildRecipesBoard(repo, { now = Date.now() } = {}) {
  const ID = FIXTURE_IDS;
  const board = openBoard(repo);
  let t = now - 90 * MIN;
  const step = () => { t += 2 * MIN; return t; };
  /** One write at the next step (or at `at`); returns fn's result. */
  const write = (fn, at = step()) => transact(board, fn, { now: at }).result;
  /** An operation by an agent, which is touched first, as the MCP server does before every call. */
  const op = (who, fn, input) => write((state, reg, at) => {
    touchAgent(reg, { id: who, folder: repo, seq: state.seq }, at);
    const out = fn({ state, reg, cfg: DEFAULTS, agentId: who, now: at }, input);
    return { events: out.events, registry: reg, result: out.result };
  });
  /** create_task, checking that the new task got its FIXTURE_IDS number (a board that is not empty would shift them). */
  const create = (who, id, input) => {
    const got = op(who, createTask, input).id;
    if (got !== id) throw new Error(`recipes-app fixture: expected task #${id}, got #${got}; build it on an empty board`);
  };
  const agents = { amber: 'fixture-amber', jade: 'fixture-jade', cobalt: 'fixture-cobalt' };
  // Register in palette order, so the names are Amber, Jade, Cobalt.
  for (const id of Object.values(agents)) {
    write((state, reg, at) => {
      touchAgent(reg, { id, folder: repo, seq: state.seq }, at);
      return { registry: reg };
    });
  }

  const { amber, jade, cobalt } = agents;
  create(amber, ID.search, { kind: 'epic', title: 'Search', requestedByHuman: true });
  create(amber, ID.filters, { kind: 'epic', title: 'Filters', parent: ID.search, requestedByHuman: true });
  create(amber, ID.accounts, { kind: 'epic', title: 'Accounts', requestedByHuman: true });
  create(amber, ID.byIngredient, {
    title: 'Search by ingredient', parent: ID.search, description: 'Typing an ingredient lists every recipe that uses it.', requestedByHuman: true,
  });
  create(amber, ID.vegetarian, {
    title: 'Vegetarian filter', parent: ID.filters, labels: ['improvement'], description: 'A toggle that hides recipes with meat or fish.',
    requestedByHuman: true,
  });
  create(jade, ID.prepTime, { title: 'Filter by prep time', parent: ID.filters, description: 'Filter recipes by how long they take.', requestedByHuman: true });
  create(amber, ID.passwordReset, { title: 'Password reset email', parent: ID.accounts, requestedByHuman: true });
  create(amber, ID.rememberMe, { title: 'Remember me on login', parent: ID.accounts, requestedByHuman: true });
  create(cobalt, ID.photoUpload, { title: 'Profile photo upload', parent: ID.accounts, labels: ['ui'], requestedByHuman: true });
  create(amber, ID.favorites, { title: 'Save favorite recipes', requestedByHuman: true });
  create(amber, ID.cachePhotos, { title: 'Cache recipe photos', labels: ['improvement'], description: 'Photos load slowly on repeat visits.' }); // suggestion
  create(jade, ID.darkMode, { title: 'Dark mode for the recipe view', labels: ['ui'] }); // suggestion
  create(amber, ID.pagination, { title: 'Search results pagination', parent: ID.search, dependsOn: [ID.vegetarian], requestedByHuman: true });
  create(amber, ID.rounding, { title: 'Fix the unit conversion rounding', labels: ['bug'], requestedByHuman: true });

  op(jade, claimTask, { id: ID.byIngredient });
  op(jade, postMessage, { taskId: ID.byIngredient, kind: 'comment', text: 'Using the existing ingredient index; no schema change.' });
  op(jade, completeTask, { id: ID.byIngredient, summary: 'Search by ingredient works from the search box, with tests for plurals.' });
  op(amber, claimTask, { id: ID.rounding });
  op(amber, completeTask, { id: ID.rounding, summary: 'Rounding now keeps one decimal for grams and none for cups.' });
  // Only release_task writes a handoff (post_message cannot), so Cobalt releases #9 with its note and
  // picks it up again; its session then ends (SessionEnd hook) while it holds #9, and nothing releases it.
  op(cobalt, claimTask, { id: ID.photoUpload });
  op(cobalt, releaseTask, { id: ID.photoUpload, note: 'Upload form done; next step: resize on the server before saving.' });
  op(cobalt, claimTask, { id: ID.photoUpload });
  write((state, reg, at) => {
    endAgent(reg, cobalt, at);
    return { registry: reg };
  });
  op(amber, claimTask, { id: ID.vegetarian });
  op(amber, updateTask, {
    id: ID.vegetarian,
    checklist: [
      { text: 'Diet field on recipes', done: true }, { text: 'Filter in the API', done: true }, { text: 'Toggle in the UI', done: true },
      { text: 'Empty state', done: false }, { text: 'Tests', done: false },
    ],
  });
  op(jade, claimTask, { id: ID.prepTime });
  op(jade, postMessage, { taskId: ID.prepTime, kind: 'question', to: 'human', text: 'Should "quick" mean under 15 or under 30 minutes?' });
  op(jade, postMessage, { taskId: ID.vegetarian, kind: 'comment', text: 'The prep-time filter will reuse the same toggle row; see #13 too.' });
  // Amber's last edit, 2 min before now, as the PostToolUse hook records it: the file on the claimed
  // task and the agent's lastFile. Jade was seen then too, so both count as active.
  write((state, reg, at) => {
    const a = getAgent(reg, amber);
    const { events } = touchTaskFile({ state, reg, cfg: DEFAULTS, agentId: amber, now: at }, 'src/filters/diet.js');
    Object.assign(a, { lastSeen: at, lastFile: 'src/filters/diet.js', lastFileAt: at });
    getAgent(reg, jade).lastSeen = at;
    return { events, registry: reg };
  }, now - 2 * MIN);
  return board;
}
