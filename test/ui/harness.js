import { chromium } from 'playwright';
import { touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { createTask } from '../../src/core/ops.js';
import { transact } from '../../src/core/store.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildRecipesBoard } from '../fixtures/recipes-app.js';
import { tempRepo } from '../helpers.js';

/**
 * The browser harness of the UI tests (npm run test:ui).
 *
 * @typedef {import('playwright').Page} Page
 * @typedef {import('../../src/core/store.js').Board} Board
 * @typedef {{ page: Page, url: string, board: Board, repo: string, dash: Awaited<ReturnType<typeof startDashboard>> }} DashboardContext
 */

/**
 * Runs `fn` against a dashboard on the recipes-app fixture, built in a fresh temp repository with the
 * real clock, in headless Chromium at 1440x900.
 * - Every console error, uncaught page error, failed request and HTTP answer of 400 or more is
 *   collected, and fails the test when `fn` is done. A request the page cancels (net::ERR_ABORTED,
 *   such as the event stream on a reload) is not a failure, and neither is an answer of 400 or more
 *   whose URL matches `allow`, nor the "Failed to load resource" console error Chrome logs for it.
 * - The browser and the server are always closed afterwards, whatever happened.
 * @param {(ctx: DashboardContext) => Promise<void>} fn
 * @param {{ dashboard?: Record<string, any>, colorScheme?: 'light' | 'dark', allow?: RegExp[] }} [opts]
 *   dashboard: more startDashboard options (now, watch...); colorScheme: the system theme the page sees;
 *   allow: URLs expected to fail (such as a missing task's /api/task/999)
 */
export async function withDashboard(fn, { dashboard = {}, colorScheme = 'light', allow = [] } = {}) {
  const repo = tempRepo();
  const board = buildRecipesBoard(repo, { now: Date.now() });
  const dash = await startDashboard({ board, port: 0, ...dashboard });
  /** @type {string[]} */
  const problems = [];
  let watching = true;
  const report = (text) => {
    if (watching) problems.push(text);
  };
  const allowed = (/** @type {string} */ u) => allow.some((re) => re.test(u));
  /** @type {import('playwright').Browser | undefined} */
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme });
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (m.text().startsWith('Failed to load resource') && allowed(m.location().url)) return;
      report(`console error: ${m.text()}`);
    });
    page.on('pageerror', (err) => report(`page error: ${err.message}`));
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? 'failed';
      if (why !== 'net::ERR_ABORTED') report(`request failed: ${r.url()} (${why})`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !allowed(r.url())) report(`HTTP ${r.status()}: ${r.url()}`);
    });
    try {
      await fn({ page, url: dash.url, board, repo, dash });
    } catch (err) {
      if (problems.length && err instanceof Error) err.message += `\nThe page also reported:\n${problems.join('\n')}`;
      throw err;
    }
    watching = false;
    if (problems.length) throw new Error(`The page reported problems:\n${problems.join('\n')}`);
  } finally {
    watching = false;
    try {
      await browser?.close();
    } finally {
      await dash.close();
    }
  }
}

/**
 * Writes a task the human asked for, relayed by Amber, as the fixture writes its tasks (it lands in
 * Ready). @param {Board} board @param {string} repo @param {string} title
 * @param {Record<string, unknown>} [more] more create_task fields (description, parent...) @returns {number} its id
 */
export function requestTask(board, repo, title, more = {}) {
  const agentId = 'fixture-amber';
  return transact(board, (state, reg, at) => {
    touchAgent(reg, { id: agentId, folder: repo, seq: state.seq }, at);
    const out = createTask({ state, reg, cfg: DEFAULTS, agentId, now: at }, { ...more, title, requestedByHuman: true });
    return { events: out.events, registry: reg, result: out.result.id };
  }).result;
}
