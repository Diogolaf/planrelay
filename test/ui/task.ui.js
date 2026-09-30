import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { postMessage, updateTask } from '../../src/core/ops.js';
import { transact } from '../../src/core/store.js';
import { FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { requestTask, withDashboard } from './harness.js';

/** @typedef {import('playwright').Page} Page */

/**
 * Runs an operation as Amber, as the MCP server does (the agent is touched first).
 * @param {import('../../src/core/store.js').Board} board @param {string} repo @param {Function} fn @param {object} input
 */
function asAmber(board, repo, fn, input) {
  return transact(board, (state, reg, at) => {
    touchAgent(reg, { id: 'fixture-amber', folder: repo, seq: state.seq }, at);
    const out = fn({ state, reg, cfg: DEFAULTS, agentId: 'fixture-amber', now: at }, input);
    return { events: out.events, registry: reg, result: out.result };
  }).result;
}

/** Opens a task's page and waits for its first render. @param {Page} page @param {string} url @param {number} id */
async function openTask(page, url, id) {
  await page.goto(`${url}#/task/${id}`);
  await page.getByTestId('task-title').waitFor();
}

/** A conversation entry by its tag. @param {Page} page @param {string} tag */
const entry = (page, tag) => page.getByTestId('conversation-entry').filter({ has: page.getByTestId('entry-tag').getByText(tag, { exact: true }) });

test('#6: the question callout with its request, and the question in the conversation', () => withDashboard(async ({ page, url }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  await openTask(page, url, ID.prepTime);
  assert.equal(await page.getByTestId('task-title').textContent(), `#${ID.prepTime} Filter by prep time`);
  const callout = page.getByTestId('question-callout');
  assert.match(String(await callout.getByTestId('question-head').textContent()), /^QUESTION FOR YOU · (JUST NOW|\d+ MIN AGO)$/);
  const question = callout.getByTestId('question-text');
  assert.equal(await question.textContent(), 'Should "quick" mean under 15 or under 30 minutes?');
  assert.equal(await question.getAttribute('dir'), 'auto');
  await callout.getByText('To answer, ask any agent:', { exact: true }).waitFor();
  assert.equal(await callout.getByTestId('ask-text').textContent(), `answer #${ID.prepTime}: `);
  await callout.getByTestId('copy').click();
  await callout.getByTestId('copy').filter({ hasText: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `answer #${ID.prepTime}: `);

  const meta = page.getByTestId('task-meta');
  assert.equal(await meta.getByTestId('status-pill').textContent(), 'Blocked · waiting on you');
  assert.match(String(await meta.getByTestId('task-agent').textContent()), /^JJade has had it for \d+ min$/);
  await meta.getByText('requested by you', { exact: true }).waitFor();

  const asked = entry(page, 'QUESTION → YOU');
  assert.equal(await asked.count(), 1);
  assert.match(String(await asked.textContent()), /Jade.*Should "quick" mean under 15 or under 30 minutes\?/);
  const created = entry(page, 'CREATED');
  assert.equal(await created.getByTestId('entry-author').textContent(), 'You'); // no "(relayed by …)" on the creation
  assert.equal(await created.getByTestId('entry-text').textContent(), 'Requested the task and put it in the Filters epic.');
  assert.deepEqual(await page.getByTestId('entry-tag').allTextContents(), ['CREATED', 'QUESTION → YOU']); // oldest first
  // no checklist, no dependencies, no files: the checklist is left out, the cards say so
  assert.equal(await page.getByTestId('checklist').count(), 0);
  await page.getByTestId('dependencies').getByText('No dependencies.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('files').getByTestId('files-count').textContent(), '0');
}));

test('#5: breadcrumb, checklist, the comment from Jade, the details, BLOCKS #13, files and the timeline link', () => withDashboard(async ({ page, url }) => {
  await openTask(page, url, ID.vegetarian);
  const crumbs = page.getByTestId('breadcrumb');
  assert.equal((await crumbs.textContent())?.replace(/\s+/g, ' ').trim(), `Board › Search › Filters › #${ID.vegetarian}`);
  assert.deepEqual(await crumbs.getByRole('link').evaluateAll((els) => els.map((a) => a.getAttribute('href'))),
    ['#/board', `#/board?epic=${ID.search}`, `#/board?epic=${ID.filters}`]);

  const checklist = page.getByTestId('checklist');
  assert.equal((await checklist.getByRole('heading').textContent())?.replace(/\s+/g, ' '), 'Checklist · 3 of 5');
  const items = checklist.getByTestId('checklist-item');
  assert.equal(await items.count(), 5);
  assert.deepEqual(await items.evaluateAll((els) => els.map((e) => e.classList.contains('is-done'))), [true, true, true, false, false]);
  assert.equal(await items.nth(3).textContent(), 'Empty state');

  assert.match(String(await page.getByTestId('task-agent').textContent()), /Amber has had it for \d+ min/);
  const comment = entry(page, 'COMMENT');
  assert.equal(await comment.getByTestId('entry-author').textContent(), 'Jade');
  assert.equal(await comment.getByTestId('entry-text').textContent(), 'The prep-time filter will reuse the same toggle row; see #13 too.');
  assert.match(String(await comment.getByTestId('entry-when').textContent()), /^(just now|\d+ min ago)$/);
  assert.equal(await page.getByTestId('description').textContent(), 'A toggle that hides recipes with meat or fish.');

  const details = page.getByTestId('details');
  const detail = (/** @type {string} */ key) => details.getByTestId(`detail-${key}`).textContent();
  assert.equal(await detail('status'), 'In progress');
  assert.match(String(await detail('agent')), /^Amber, for \d+ min$/);
  assert.equal(await detail('epic'), 'Search › Filters');
  assert.equal(await detail('labels'), 'improvement');
  assert.equal(await detail('origin'), 'Requested by you');
  assert.match(String(await detail('created')), /^\d+ (min|h) ago$/);

  const deps = page.getByTestId('dependencies');
  assert.equal(await deps.getByTestId('deps-depends-on').count(), 0);
  const blocks = deps.getByTestId('deps-blocks');
  assert.equal(await blocks.getByTestId('deps-rel').textContent(), 'BLOCKS');
  const row = blocks.getByTestId('dep-row');
  assert.equal(await row.getByRole('link').textContent(), `#${ID.pagination} Search results pagination`);
  assert.equal(await row.getByRole('link').getAttribute('href'), `#/task/${ID.pagination}`);
  assert.equal(await row.getByTestId('status-pill').textContent(), 'Blocked');

  const files = page.getByTestId('files');
  assert.equal(await files.getByTestId('files-count').textContent(), '1');
  assert.deepEqual(await files.getByTestId('file-row').allTextContents(), ['src/filters/diet.jsAmber']);

  const timeline = page.getByTestId('links').getByRole('link', { name: /^Full timeline · \d+ events$/ });
  assert.equal(await timeline.textContent(), 'Full timeline · 5 events');
  await timeline.click();
  await page.waitForURL(new RegExp(`#/activity\\?task=${ID.vegetarian}$`));
  await page.getByTestId('activity-heading').getByText(`Timeline of #${ID.vegetarian}`, { exact: true }).waitFor();
  assert.equal(await page.getByTestId('activity-row').count(), 5);
}));

test('#9: the handoff from Cobalt, whose session ended', () => withDashboard(async ({ page, url }) => {
  await openTask(page, url, ID.photoUpload);
  assert.equal(await page.getByTestId('task-agent').textContent(), "CCobalt's session ended");
  const handoff = entry(page, 'HANDOFF');
  assert.equal(await handoff.getByTestId('entry-author').textContent(), 'Cobalt');
  assert.equal(await handoff.getByTestId('entry-text').textContent(), 'Upload form done; next step: resize on the server before saving.');
  assert.equal(await page.getByTestId('details').getByTestId('detail-agent').textContent(), 'Cobalt, session ended');
  assert.equal(await page.getByTestId('question-callout').count(), 0);
}));

test('a message the human relayed through an agent reads "You (relayed by …)"; links: web in a new tab, repository paths as text', () => withDashboard(async ({ page, url, board, repo }) => {
  const id = requestTask(board, repo, 'Print a recipe card', { description: 'One card per recipe.\nIngredients on the left, steps on the right.' });
  asAmber(board, repo, updateTask, { id, links: [{ title: 'Plan', target: 'docs/print.md' }, { title: 'Print styles', target: 'https://example.com/print' }] });
  asAmber(board, repo, postMessage, { taskId: id, kind: 'comment', text: 'Use the large font for the title.', relayedFromHuman: true });
  await openTask(page, url, id);
  const relayed = entry(page, 'COMMENT');
  assert.equal(await relayed.getByTestId('entry-author').textContent(), 'You (relayed by Amber)');
  assert.equal(await relayed.getByTestId('entry-text').textContent(), 'Use the large font for the title.');
  const links = page.getByTestId('links');
  const web = links.getByRole('link', { name: 'Print styles' });
  assert.equal(await web.getAttribute('href'), 'https://example.com/print');
  assert.equal(await web.getAttribute('target'), '_blank');
  assert.equal(await web.getAttribute('rel'), 'noopener noreferrer');
  const plan = links.getByTestId('link-row').filter({ hasText: 'Plan' });
  assert.equal(await plan.getByRole('link').count(), 0);
  assert.equal(await plan.locator('.mono').textContent(), 'docs/print.md');
  // the description keeps its line break, as text
  const description = page.getByTestId('description');
  assert.equal(await description.textContent(), 'One card per recipe.\nIngredients on the left, steps on the right.');
  assert.equal(await description.evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap');
  assert.equal(await description.locator('br').count(), 0);
  assert.equal(await links.getByRole('link', { name: 'Full timeline · 1 event' }).count(), 1);
}));

test('a live change reaches the task view, and waits while text in the conversation is selected', () => withDashboard(async ({ page, url, board, repo }) => {
  await openTask(page, url, ID.vegetarian);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  const entries = page.getByTestId('conversation-entry');
  assert.equal(await entries.count(), 2);
  await page.evaluate(() => {
    const text = /** @type {Element} */ (document.querySelectorAll('[data-testid="entry-text"]')[1]);
    const range = document.createRange();
    range.selectNodeContents(text);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    /** @type {any} */ (window).shown = document.querySelector('[data-testid="task-view"]');
  });
  const loaded = page.waitForResponse((r) => r.url().endsWith(`/api/task/${ID.vegetarian}`));
  asAmber(board, repo, postMessage, { taskId: ID.vegetarian, kind: 'comment', text: 'Empty state copy is in the design notes.' });
  await loaded;
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).shown === document.querySelector('[data-testid="task-view"]')), true);
  assert.equal(await page.evaluate(() => getSelection()?.toString()), 'The prep-time filter will reuse the same toggle row; see #13 too.');
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await entries.nth(2).getByText('Empty state copy is in the design notes.', { exact: true }).waitFor();
  assert.equal(await entries.nth(2).getByTestId('entry-author').textContent(), 'Amber');
}));

test('at 1024 px the task view fits: the sidebar beside the main column, no horizontal scroll', () => withDashboard(async ({ page, url }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openTask(page, url, ID.vegetarian);
  await page.evaluate(() => document.fonts.ready);
  const main = await page.locator('.task-main').boundingBox();
  const side = await page.getByTestId('details').boundingBox();
  assert.ok(main && side && side.x >= main.x + main.width && side.x + side.width <= 1024, `main ${JSON.stringify(main)}, side ${JSON.stringify(side)}`);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 1024, `no horizontal scroll: ${width}`);
  const cut = await page.getByTestId('task-view').evaluate((view) => [...view.querySelectorAll('*')]
    .filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map((e) => e.textContent));
  assert.deepEqual(cut, []);
}));

test('the timeline: "Showing the most recent N events" once the ring lost the start, and no link when it holds nothing', () => withDashboard(async ({ page, url }) => {
  // a ring of 500 entries is slow to write: the task's answer is changed on its way to the page instead
  let timeline = { count: 12, truncated: true };
  await page.route(/\/api\/task\/\d+$/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), timeline } });
  });
  await openTask(page, url, ID.vegetarian);
  const shown = page.getByTestId('links').getByTestId('timeline');
  assert.equal(await shown.textContent(), 'Showing the most recent 12 events');
  assert.equal(await shown.getAttribute('href'), `#/activity?task=${ID.vegetarian}`);
  timeline = { count: 0, truncated: true };
  await page.reload();
  await shown.filter({ hasText: 'No recent events in the activity log' }).waitFor();
  assert.equal(await shown.evaluate((el) => el.tagName), 'P');
  assert.equal(await page.getByTestId('links').getByRole('link').count(), 0);
}));

test('#999 does not exist', () => withDashboard(async ({ page, url }) => {
  await page.goto(`${url}#/task/999`);
  const missing = page.getByTestId('task-missing');
  await missing.getByText('Task #999 does not exist.', { exact: true }).waitFor();
  await missing.getByRole('link', { name: 'Back to the Board' }).click();
  await page.waitForURL(/#\/board$/);
  await page.getByTestId('board-toolbar').waitFor();
}, { allow: [/\/api\/task\/999$/] }));

test('untrusted text is inert: markup in a title stays text, a right-to-left override stays isolated', () => withDashboard(async ({ page, url, board, repo }) => {
  const rlo = String.fromCharCode(0x202e);
  const title = '<img src=x onerror=alert(1)>';
  const id = requestTask(board, repo, title, { description: `Plain start ${rlo}desrever si siht` });
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await openTask(page, url, id);
  assert.equal(await page.getByTestId('task-title').textContent(), `#${id} ${title}`);
  assert.equal(await page.locator('#app img').count(), 0);
  const description = page.getByTestId('description');
  assert.equal(await description.textContent(), `Plain start ${rlo}desrever si siht`);
  assert.equal(await description.getAttribute('dir'), 'auto');
  assert.equal(await description.evaluate((el) => getComputedStyle(el).unicodeBidi), 'isolate');
  // the breadcrumb, the title and the meta row stay in order around it
  const titleBox = await page.getByTestId('task-title').boundingBox();
  const descriptionBox = await description.boundingBox();
  assert.ok(titleBox && descriptionBox && descriptionBox.y > titleBox.y);

  await page.goto(`${url}#/activity?task=${id}`);
  const row = page.getByTestId('activity-row').first();
  await row.waitFor();
  assert.match(String(await row.textContent()), /Amber created #\d+ <img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('#app img').count(), 0);
  await page.waitForTimeout(200);
  assert.equal(dialogs, 0);
}));
