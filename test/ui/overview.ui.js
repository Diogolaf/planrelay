import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { HOUR, MIN } from '../helpers.js';
import { layoutProblems, requestTask, withDashboard } from './harness.js';

/** @typedef {import('playwright').Page} Page */

/** Opens the Overview and waits for its first render. @param {Page} page @param {string} url */
async function openOverview(page, url) {
  await page.goto(url);
  await page.getByTestId('now').waitFor();
}

/** The Needs-you row of a kind chip. @param {Page} page @param {'QUESTION' | 'APPROVE' | 'STALLED'} kind */
const needsRow = (page, kind) => page.getByTestId('needs-you-row').filter({ has: page.getByText(kind, { exact: true }) });

test('Needs you: the question, the suggestions to approve and the stalled claim, each with its request', () => withDashboard(async ({ page, url }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  await openOverview(page, url);
  const section = page.getByTestId('needs-you');
  assert.equal(await section.getByTestId('needs-you-row').count(), 3);
  assert.equal(await section.getByTestId('needs-you-count').textContent(), '3');
  await section.getByText('The dashboard only shows. To act, ask any agent.', { exact: true }).waitFor();

  const question = needsRow(page, 'QUESTION');
  assert.equal(await question.getByTestId('ask-text').textContent(), `answer #${ID.prepTime}: `);
  const questionText = await question.textContent();
  assert.match(questionText, /Filter by prep time/);
  assert.match(questionText, /Should "quick" mean under 15 or under 30 minutes\?/);
  assert.match(questionText, /asked by Jade · \d+ min ago/);
  await question.getByTestId('copy').click();
  await question.getByTestId('copy').filter({ hasText: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `answer #${ID.prepTime}: `);
  await question.getByTestId('copy').filter({ hasNotText: 'Copied' }).waitFor({ timeout: 4000 }); // back after 2 s

  const approve = needsRow(page, 'APPROVE');
  assert.equal(await approve.getByTestId('ask-text').textContent(), `approve #${ID.cachePhotos} and #${ID.darkMode}`);
  assert.match(await approve.textContent(), /Cache recipe photos.*Dark mode for the recipe view/);

  const stalled = needsRow(page, 'STALLED');
  assert.equal(await stalled.getByTestId('ask-text').textContent(), `resume #${ID.photoUpload}`);
  assert.match(await stalled.textContent(), /Cobalt's session ended · released automatically in \d+ h/);
}));

test('Needs you: at 1024 px the question and the release time are shown whole', () => withDashboard(async ({ page, url }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openOverview(page, url);
  await page.evaluate(() => document.fonts.ready);
  /** Nothing in the detail box is cut, and the text `part` lies inside it. */
  const shownWhole = (/** @type {'QUESTION' | 'STALLED'} */ kind, /** @type {string} */ part) => needsRow(page, kind).getByTestId('needs-detail')
    .evaluate((el, text) => {
      const clipped = [el, ...el.querySelectorAll('*')].filter((e) => getComputedStyle(e).overflowX !== 'visible'
        && (e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight));
      const node = [el, ...el.querySelectorAll('*')].flatMap((e) => [...e.childNodes])
        .find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').includes(text));
      if (clipped.length > 0 || !node) return `clipped: ${clipped.length}, text found: ${Boolean(node)}`;
      const range = document.createRange();
      const at = (node.textContent ?? '').indexOf(text);
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const box = el.getBoundingClientRect();
      const rects = [...range.getClientRects()];
      const inside = rects.length > 0
        && rects.every((r) => r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.bottom <= box.bottom + 0.5);
      return inside ? 'whole' : 'outside the box';
    }, part);
  assert.equal(await shownWhole('QUESTION', 'Should "quick" mean under 15 or under 30 minutes?'), 'whole');
  assert.equal(await shownWhole('STALLED', 'released automatically in '), 'whole');
  const question = needsRow(page, 'QUESTION').getByTestId('needs-detail');
  assert.match(String(await question.getAttribute('title')), /^Should "quick" mean under 15 or under 30 minutes\? · asked by Jade · \d+ min ago$/);
}));

test('at 1024 px no card is cut off and nothing scrolls sideways', () => withDashboard(async ({ page, url }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openOverview(page, url);
  await page.evaluate(() => document.fonts.ready);
  // the panels are the cards here, Now holds one card per agent
  const cards = ['needs-you', 'agent-card', 'shipped-today', 'epics', 'where-the-work-is', 'next-in-line']
    .map((id) => `[data-testid="${id}"]`).join(', ');
  assert.equal(await page.locator(cards).count(), 7); // Amber and Jade in Now
  assert.deepEqual(await layoutProblems(page, cards), []);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 1024, `no horizontal scroll: ${width}`);
}));

test('Needs you: "Copied" outlives a live re-render, then goes after 2 s', () => withDashboard(async ({ page, url, board, repo }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  await page.clock.install();
  await openOverview(page, url);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  await page.clock.pauseAt(Date.now() + 1000); // the page's timers wait for runFor from here
  const copy = needsRow(page, 'APPROVE').getByTestId('copy');
  await copy.click();
  await copy.filter({ hasText: 'Copied' }).waitFor();
  const ready = page.getByTestId('legend-row').filter({ hasText: 'Ready' }).getByTestId('legend-count');
  assert.equal(await ready.textContent(), '3');
  requestTask(board, repo, 'Print a recipe card');
  await ready.filter({ hasText: /^4$/ }).waitFor(); // the Overview was built again
  assert.equal(await copy.textContent().then((t) => t?.includes('Copied')), true);
  await page.clock.runFor(2100);
  await copy.filter({ hasNotText: 'Copied' }).waitFor();
}));

test('Needs you: when the clipboard refuses, the request is selected instead', () => withDashboard(async ({ page, url }) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError'));
  });
  await openOverview(page, url);
  const row = needsRow(page, 'STALLED');
  await row.getByTestId('copy').click();
  await page.waitForFunction(() => window.getSelection()?.toString() !== '');
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), `resume #${ID.photoUpload}`);
  assert.equal(await row.getByTestId('copy').filter({ hasText: 'Copied' }).count(), 0);
}));

test('Now: a card per live agent, with its task, checklist, last file or blocking reason', () => withDashboard(async ({ page, url }) => {
  await openOverview(page, url);
  const cards = page.getByTestId('agent-card');
  assert.equal(await cards.count(), 2); // Cobalt's session ended
  const amber = cards.filter({ hasText: 'Amber' });
  for (const text of ['A', 'In progress', 'checklist 3/5', 'src/filters/diet.js']) await amber.getByText(text, { exact: true }).waitFor();
  assert.match(await amber.textContent(), /just now|\d+ min ago/);
  const link = amber.getByRole('link', { name: `#${ID.vegetarian} Vegetarian filter` });
  assert.equal(await link.getAttribute('href'), `#/task/${ID.vegetarian}`);
  const jade = cards.filter({ hasText: 'Jade' });
  for (const text of ['Blocked', 'Waiting for your answer']) await jade.getByText(text, { exact: true }).waitFor();
  assert.equal(await jade.getByRole('link', { name: `#${ID.prepTime} Filter by prep time` }).getAttribute('href'), `#/task/${ID.prepTime}`);
}));

test('Shipped today: the tasks done since midnight, newest first, with their summaries', (t) => withDashboard(async ({ page, url }) => {
  const midnight = new Date().setHours(0, 0, 0, 0);
  if (Date.now() - midnight < 90 * MIN) return void t.skip('the fixture finished its tasks before midnight');
  await openOverview(page, url);
  const rows = page.getByTestId('shipped-today').getByTestId('shipped-row');
  const texts = await rows.allTextContents();
  assert.deepEqual(texts.map((s) => /^#(\d+) /.exec(s)?.[1]), [String(ID.rounding), String(ID.byIngredient)]);
  assert.match(texts[0], /Fix the unit conversion rounding · Amber · \d+ min ago/);
  assert.match(texts[0], /Rounding now keeps one decimal for grams and none for cups\./);
}));

test('the right column: epics, where the work is, next in line', () => withDashboard(async ({ page, url }) => {
  await openOverview(page, url);

  const epics = page.getByTestId('epics');
  const names = epics.getByTestId('epic-name');
  assert.deepEqual(await names.allTextContents(), ['Search', 'Filters', 'Accounts']);
  const rows = epics.getByTestId('epic-row');
  assert.deepEqual(await Promise.all([0, 1, 2].map((i) => rows.nth(i).getByTestId('sub-epic').count())), [0, 1, 0]);
  assert.equal(await rows.nth(1).getByTestId('sub-epic').textContent(), 'sub-epic');
  const x = await Promise.all([0, 1, 2].map(async (i) => (await names.nth(i).boundingBox())?.x ?? NaN));
  assert.ok(x[1] > x[0] && x[0] === x[2], `Filters is indented: ${x}`);
  assert.match(await rows.nth(0).textContent(), /1\/4/);
  assert.equal(await epics.getByRole('link', { name: 'See all' }).getAttribute('href'), '#/board');
  await rows.nth(1).click();
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.filters}$`));
  await page.goBack();
  await page.getByTestId('now').waitFor();

  const work = page.getByTestId('where-the-work-is');
  const legend = work.getByTestId('legend-row');
  assert.equal(await legend.count(), 5);
  assert.deepEqual(await legend.getByTestId('legend-name').allTextContents(), ['Backlog', 'Ready', 'In progress', 'Blocked', 'Done']);
  assert.deepEqual(await legend.getByTestId('legend-count').allTextContents(), ['2', '3', '2', '2', '2']);
  const segments = work.getByTestId('bar-segment');
  assert.equal(await segments.count(), 5);
  const widths = await Promise.all([0, 1].map(async (i) => (await segments.nth(i).boundingBox())?.width ?? NaN));
  assert.ok(Math.abs(widths[1] / widths[0] - 1.5) < 0.1, `Ready is 3/2 of Backlog: ${widths}`);

  const next = page.getByTestId('next-in-line');
  await next.getByText('the next free agent takes the first one', { exact: true }).waitFor();
  const texts = await next.getByTestId('next-row').allTextContents();
  assert.deepEqual(texts.map((s) => /^(\d)#(\d+) /.exec(s)?.slice(1, 3).join(' ')),
    [`1 ${ID.passwordReset}`, `2 ${ID.rememberMe}`, `3 ${ID.favorites}`]);
  assert.match(texts[0], /Password reset email.*Accounts/);
}));

test('a day later: claims past their release time, no agent at work, nothing shipped today', () => withDashboard(async ({ page, url }) => {
  // The server's clock 25 h ahead: Amber and Jade count as ended too, and every claim is past its release time.
  await openOverview(page, url);
  await page.getByTestId('now').getByText('No agent is working right now.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('agent-card').count(), 0);
  const stalled = needsRow(page, 'STALLED');
  assert.equal(await stalled.count(), 3);
  for (const text of await stalled.allTextContents()) assert.match(text, /session ended · released at the next change/);
  assert.equal(await page.getByTestId('shipped-today').count(), 0);
}, { dashboard: { now: () => Date.now() + 25 * HOUR } }));
