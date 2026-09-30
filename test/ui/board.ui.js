import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { HOUR } from '../helpers.js';
import { requestTask, withDashboard } from './harness.js';

/** @typedef {import('playwright').Page} Page */

const DAY = 24 * HOUR;
/** Every task of the fixture (not the epics). */
const ALL = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/** Opens the Board at `hash` and waits for its first render. @param {Page} page @param {string} url @param {string} [hash] */
async function openBoard(page, url, hash = '#/board') {
  await page.goto(`${url}${hash}`);
  await page.getByTestId('board-toolbar').waitFor();
}

/** The ids of the cards shown, in page order. @param {Page} page @returns {Promise<number[]>} */
const shownIds = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid^="card-"]')]
  .map((el) => /^card-(\d+)$/.exec(el.getAttribute('data-testid') ?? '')?.[1])
  .filter(Boolean)
  .map(Number));

/** Waits until the cards shown are exactly `ids` (in any order). @param {Page} page @param {number[]} ids */
async function expectCards(page, ids) {
  const want = [...ids].sort((a, b) => a - b);
  try {
    await page.waitForFunction((w) => {
      const got = [...document.querySelectorAll('[data-testid^="card-"]')]
        .map((el) => /^card-(\d+)$/.exec(el.getAttribute('data-testid') ?? '')?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b);
      return JSON.stringify(got) === JSON.stringify(w);
    }, want, { timeout: 5000 });
  } catch {
    assert.deepEqual((await shownIds(page)).sort((a, b) => a - b), want);
  }
}

/** A card. @param {Page} page @param {number} id */
const card = (page, id) => page.getByTestId(`card-${id}`);
/** A column's count. @param {Page} page @param {string} key */
const columnCount = (page, key) => page.getByTestId(`column-${key}`).getByTestId('column-count');
/** The text shown on a toolbar select. @param {Page} page @param {'epic' | 'agent' | 'label' | 'group'} name */
const filterText = (page, name) => page.getByTestId(`filter-${name}`).getByTestId('filter-text').textContent();
/** A sidebar entry. @param {Page} page @param {'side-epic' | 'side-agent' | 'side-label'} kind @param {string | RegExp} text */
const side = (page, kind, text) => page.getByTestId('board-sidebar').getByTestId(kind).filter({ hasText: text });

test('the columns: their counts and cards, in board order', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url);
  const keys = ['backlog', 'ready', 'in_progress', 'blocked', 'done'];
  const counts = await Promise.all(keys.map((k) => columnCount(page, k).textContent()));
  assert.deepEqual(counts, ['2', '3', '2', '2', '2']);
  assert.deepEqual(await page.getByTestId('board').locator('h2.column-name').allTextContents(), ['BACKLOG', 'READY', 'IN PROGRESS', 'BLOCKED', 'DONE']);
  const inColumn = (key) => page.getByTestId(`column-${key}`).evaluate((col) => [...col.querySelectorAll('[data-testid^="card-"]')]
    .map((el) => Number(/** @type {string} */ (el.getAttribute('data-testid')).slice(5))));
  assert.deepEqual(await inColumn('backlog'), [ID.cachePhotos, ID.darkMode]);
  assert.deepEqual(await inColumn('ready'), [ID.passwordReset, ID.rememberMe, ID.favorites]);
  assert.deepEqual(await inColumn('in_progress'), [ID.vegetarian, ID.photoUpload]);
  assert.deepEqual(await inColumn('blocked'), [ID.prepTime, ID.pagination]);
  assert.deepEqual(await inColumn('done'), [ID.rounding, ID.byIngredient]); // newest first
  await page.getByTestId('board-toolbar').getByText('Done shows the last 7 days', { exact: true }).waitFor();
}));

test('the cards: badge, label, epic, blocking reasons, the stalled chip, the agent and the meta', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url);
  const suggestion = card(page, ID.cachePhotos);
  assert.equal(await suggestion.getByTestId('badge-suggested').textContent(), 'suggested');
  assert.equal(await suggestion.getByTestId('label-chip').textContent(), 'improvement');
  assert.equal(await suggestion.getByTestId('meta-text').textContent(), 'suggested by Amber');
  assert.equal(await card(page, ID.favorites).getByTestId('badge-suggested').count(), 0);

  assert.equal(await card(page, ID.passwordReset).getByTestId('meta-text').textContent(), '1st in line');
  assert.equal(await card(page, ID.passwordReset).getByTestId('epic-path').textContent(), 'Accounts');

  const waits = card(page, ID.pagination);
  assert.deepEqual(await waits.getByTestId('reason-chip').allTextContents(), [`Waiting on #${ID.vegetarian}`]);
  assert.equal(await waits.getByTestId('meta-text').textContent(), `back to Ready when #${ID.vegetarian} closes`);

  const asked = card(page, ID.prepTime);
  assert.deepEqual(await asked.getByTestId('reason-chip').allTextContents(), ['Waiting on you']);
  assert.equal(await asked.getByTestId('holder').textContent(), 'JJade');
  assert.equal(await asked.getByTestId('epic-path').textContent(), 'Search › Filters');

  const stalled = card(page, ID.photoUpload);
  assert.match(String(await stalled.getByTestId('reason-chip').textContent()), /^No agent for \d+ min$/);
  assert.match(String(await stalled.getByTestId('holder').textContent()), /Cobalt/);

  const working = card(page, ID.vegetarian);
  assert.match(String(await working.getByTestId('meta-text').textContent()), /^3\/5 · \d+ min$/);
  assert.match(String(await working.getByTestId('holder').textContent()), /Amber/);

  const done = card(page, ID.rounding);
  assert.match(String(await done.getByTestId('holder').textContent()), /Amber/); // who completed it
  assert.match(String(await done.getByTestId('meta-text').textContent()), /^\d+ min ago$/);

  const title = working.getByTestId('task-title');
  assert.equal(await title.textContent(), 'Vegetarian filter');
  assert.equal(await title.locator('[dir="auto"]').count(), 1);
  await title.click();
  await page.waitForURL(new RegExp(`#/task/${ID.vegetarian}$`));
}));

test('the sidebar: every entry filters the board, and the filters combine', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url);
  const allTasks = page.getByTestId('board-sidebar').getByTestId('side-epic-all');
  assert.match(String(await allTasks.textContent()), /^All tasks\s*11$/);
  assert.equal(await allTasks.getAttribute('aria-current'), 'true');
  assert.deepEqual(await page.getByTestId('board-sidebar').getByTestId('side-epic').allTextContents(), ['Search1/4', 'Filters0/2', 'Accounts0/3']);

  await side(page, 'side-epic', 'Filters').click();
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.filters}$`));
  await expectCards(page, [ID.vegetarian, ID.prepTime]);
  assert.equal(await side(page, 'side-epic', 'Filters').getAttribute('aria-current'), 'true');
  assert.equal(await allTasks.getAttribute('aria-current'), null);
  await allTasks.click();
  await expectCards(page, ALL);

  assert.deepEqual(await page.getByTestId('side-agent').allTextContents(), ['AAmber#5', 'JJade#6', '?No agent1']);
  await side(page, 'side-agent', 'Jade').click();
  await page.waitForURL(/#\/board\?agent=fixture-jade$/);
  await expectCards(page, [ID.prepTime]);
  await side(page, 'side-agent', 'Jade').click(); // the selected entry turns its filter off
  await page.waitForURL(/#\/board$/);
  await expectCards(page, ALL);
  await side(page, 'side-agent', 'No agent').click();
  await page.waitForURL(/#\/board\?agent=none$/);
  await expectCards(page, [ID.photoUpload]);
  await page.goto(`${url}#/board`);

  assert.deepEqual(await page.getByTestId('side-label').allTextContents(), ['improvement · 2', 'ui · 2', 'bug · 1']);
  await side(page, 'side-label', 'ui').click();
  await page.waitForURL(/#\/board\?label=ui$/);
  await expectCards(page, [ID.photoUpload, ID.darkMode]);
  await side(page, 'side-epic', 'Accounts').click();
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.accounts}&label=ui$`));
  await expectCards(page, [ID.photoUpload]);
}));

test('the needs-you strip: one chip per item, and a link to the Overview', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url);
  const strip = page.getByTestId('needs-strip');
  await strip.getByText('3 things need you', { exact: true }).waitFor();
  const chips = await strip.getByTestId('strip-chip').allTextContents();
  assert.equal(chips.length, 3);
  assert.equal(chips[0], `#${ID.prepTime} question from Jade`);
  assert.equal(chips[1], '2 suggestions to approve');
  assert.match(chips[2], new RegExp(`^#${ID.photoUpload} no agent for \\d+ min$`));
  await strip.getByRole('link', { name: 'See what to ask' }).click();
  await page.waitForURL(/#\/$/);
  await page.getByTestId('needs-you').waitFor();
}));

test('search: #/board?q= shows the matches only, and asks the server once per search', () => withDashboard(async ({ page, url, board, repo }) => {
  /** @type {string[]} */
  const searches = [];
  page.on('request', (r) => { if (r.url().includes('/api/search')) searches.push(r.url()); });
  await openBoard(page, url, '#/board?q=vegetarian');
  await expectCards(page, [ID.vegetarian]);
  assert.equal(await page.getByTestId('search').inputValue(), 'vegetarian');
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  await page.evaluate(() => { /** @type {any} */ (window).shown = document.querySelector('[data-testid="board"]'); });
  requestTask(board, repo, 'Print a recipe card');
  await page.waitForFunction(() => document.querySelector('[data-testid="board"]') !== /** @type {any} */ (window).shown); // built again
  await expectCards(page, [ID.vegetarian]);
  assert.equal(searches.length, 1);
  await page.getByTestId('search').fill('filter');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/board\?q=filter$/);
  await expectCards(page, [ID.vegetarian, ID.prepTime]);
  assert.equal(searches.length, 2);
}));

test('the toolbar selects set the filters in the hash, and hold a live render while open', () => withDashboard(async ({ page, url, board, repo }) => {
  await openBoard(page, url);
  const agent = page.getByTestId('filter-agent');
  assert.equal(await filterText(page, 'agent'), 'Agent: all');
  assert.deepEqual(await page.getByTestId('board-toolbar').getByTestId('filter-text').allTextContents(),
    ['Epic: all', 'Agent: all', 'Label: all', 'Group by: none']);
  // the select covers its button: a click anywhere on it reaches the select
  const hit = await agent.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + 6, r.top + r.height / 2)?.tagName;
  });
  assert.equal(hit, 'SELECT');
  await agent.locator('select').focus();
  await agent.locator('select').selectOption('fixture-jade');
  await page.waitForURL(/#\/board\?agent=fixture-jade$/);
  await expectCards(page, [ID.prepTime]);
  assert.equal(await filterText(page, 'agent'), 'Agent: Jade');
  assert.equal(await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).dataset.key), 'filter-agent');

  await page.getByTestId('filter-epic').locator('select').selectOption(String(ID.filters));
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.filters}&agent=fixture-jade$`));
  await page.getByTestId('filter-agent').locator('select').selectOption('');
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.filters}$`));
  await expectCards(page, [ID.vegetarian, ID.prepTime]);

  // a select opened from the keyboard holds the live render until it is left
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  const label = page.getByTestId('filter-label').locator('select');
  await label.dispatchEvent('keydown', { key: ' ' });
  await page.evaluate(() => { /** @type {any} */ (window).shown = document.querySelector('[data-testid="board"]'); });
  const first = page.waitForResponse((r) => r.url().endsWith('/api/view'));
  requestTask(board, repo, 'Print a recipe card');
  await first;
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).shown === document.querySelector('[data-testid="board"]')), true);
  await label.dispatchEvent('focusout');
  await page.waitForFunction(() => document.querySelector('[data-testid="board"]') !== /** @type {any} */ (window).shown);

  // a pressed select holds the live render until it changes
  const group = page.getByTestId('filter-group').locator('select');
  await group.dispatchEvent('pointerdown');
  await page.evaluate(() => { /** @type {any} */ (window).shown = document.querySelector('[data-testid="board"]'); });
  const loaded = page.waitForResponse((r) => r.url().endsWith('/api/view'));
  requestTask(board, repo, 'Print a shopping list');
  await loaded;
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).shown === document.querySelector('[data-testid="board"]')), true);
  await group.selectOption('epic');
  await page.waitForURL(new RegExp(`#/board\\?epic=${ID.filters}&group=epic$`));
  await page.getByTestId('lane').first().waitFor();
}));

test('group by epic and by agent: one swimlane per group', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url, '#/board?group=epic');
  await page.getByTestId('lane').first().waitFor();
  assert.deepEqual(await page.getByTestId('lane-name').allTextContents(), ['Search', 'Filters', 'Accounts', 'No epic']);
  assert.equal(await filterText(page, 'group'), 'Group by: epic');
  const lane = (name) => page.getByTestId('lane').filter({ has: page.getByTestId('lane-name').getByText(name, { exact: true }) });
  const idsIn = (name) => lane(name).evaluate((el) => [...el.querySelectorAll('[data-testid^="card-"]')]
    .map((c) => Number(/** @type {string} */ (c.getAttribute('data-testid')).slice(5))));
  assert.deepEqual(await idsIn('Search'), [ID.pagination, ID.byIngredient]);
  assert.deepEqual(await idsIn('Filters'), [ID.vegetarian, ID.prepTime]);
  assert.deepEqual(await idsIn('Accounts'), [ID.passwordReset, ID.rememberMe, ID.photoUpload]);
  assert.deepEqual(await idsIn('No epic'), [ID.cachePhotos, ID.darkMode, ID.favorites, ID.rounding]);
  assert.deepEqual(await lane('Filters').getByTestId('lane-cell-in_progress').locator('[data-testid^="card-"]').count(), 1);
  // the column heads count every lane
  assert.equal(await columnCount(page, 'ready').textContent(), '3');

  await page.goto(`${url}#/board?group=agent`);
  await page.getByTestId('filter-group').getByTestId('filter-text').filter({ hasText: 'Group by: agent' }).waitFor();
  assert.deepEqual(await page.getByTestId('lane-name').allTextContents(), ['Amber', 'Jade', 'No agent', 'Unassigned']);
  assert.deepEqual(await idsIn('No agent'), [ID.photoUpload]);
  assert.deepEqual(await idsIn('Jade'), [ID.prepTime]);
}));

test('Backlog and Ready show 20, then "+ N more", which stays open across live renders', () => withDashboard(async ({ page, url, board, repo }) => {
  for (let i = 1; i <= 20; i += 1) requestTask(board, repo, `Recipe idea ${i}`);
  await openBoard(page, url);
  const ready = page.getByTestId('column-ready');
  await columnCount(page, 'ready').filter({ hasText: /^23$/ }).waitFor();
  assert.equal(await ready.locator('[data-testid^="card-"]').count(), 20);
  const more = ready.getByTestId('column-more');
  assert.equal(await more.textContent(), '+ 3 more');
  await more.click();
  await ready.getByTestId('column-more').filter({ hasText: 'Show fewer' }).waitFor();
  assert.equal(await ready.locator('[data-testid^="card-"]').count(), 23);
  assert.equal(await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement).dataset.key), 'more-all-ready');
  requestTask(board, repo, 'Print a recipe card');
  await columnCount(page, 'ready').filter({ hasText: /^24$/ }).waitFor();
  assert.equal(await ready.locator('[data-testid^="card-"]').count(), 24);
  await ready.getByTestId('column-more').click();
  await ready.getByTestId('column-more').filter({ hasText: '+ 4 more' }).waitFor();
  assert.equal(await ready.locator('[data-testid^="card-"]').count(), 20);
  assert.equal(await page.getByTestId('column-in_progress').getByTestId('column-more').count(), 0);
}));

test('Done shows the last 7 days; "See all N" shows the rest', () => withDashboard(async ({ page, url }) => {
  // The server's clock 8 days ahead: both done tasks are older than 7 days.
  await openBoard(page, url);
  const done = page.getByTestId('column-done');
  assert.equal(await columnCount(page, 'done').textContent(), '2');
  assert.equal(await done.locator('[data-testid^="card-"]').count(), 0);
  await done.getByRole('link', { name: 'See all 2' }).click();
  await page.waitForURL(/#\/board\?done=all$/);
  await expectCards(page, ALL);
  assert.equal(await done.locator('[data-testid^="card-"]').count(), 2);
  await page.getByTestId('board-toolbar').getByText('Done shows every task', { exact: false }).waitFor();
  await page.getByTestId('board-toolbar').getByRole('link', { name: 'Show the last 7 days' }).click();
  await page.waitForURL(/#\/board$/);
  await done.getByRole('link', { name: 'See all 2' }).waitFor();
}, { dashboard: { now: () => Date.now() + 8 * DAY } }));

test('a filter that matches nothing, or names what no longer exists, shows "No tasks match these filters."', () => withDashboard(async ({ page, url }) => {
  await openBoard(page, url, '#/board?epic=99&group=epic');
  const empty = page.getByTestId('board-empty');
  await empty.getByText('No tasks match these filters.', { exact: true }).waitFor();
  assert.equal(await filterText(page, 'epic'), 'Epic: #99');
  assert.equal(await page.getByTestId('filter-epic').locator('select').inputValue(), '99');
  await empty.getByRole('link', { name: 'Clear filters' }).click();
  await page.waitForURL(/#\/board\?group=epic$/);
  await expectCards(page, ALL);

  await page.goto(`${url}#/board?agent=fixture-gone&label=nothing`);
  await empty.waitFor();
  assert.equal(await filterText(page, 'agent'), 'Agent: unknown');
  assert.equal(await filterText(page, 'label'), 'Label: nothing');
}));

test('at 1024 px every card shows its content whole, with nothing overlapping', () => withDashboard(async ({ page, url }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, url);
  await page.evaluate(() => document.fonts.ready);
  const problems = await page.evaluate(() => {
    const out = [];
    for (const c of document.querySelectorAll('[data-testid^="card-"]')) {
      const box = c.getBoundingClientRect();
      const leaves = [...c.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() !== '');
      for (const e of [c, ...c.querySelectorAll('*')]) {
        if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible') out.push(`${c.getAttribute('data-testid')}: "${e.textContent}" is cut`);
      }
      const rects = leaves.map((e) => [e, e.getBoundingClientRect()]);
      for (const [e, r] of rects) {
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) {
          out.push(`${c.getAttribute('data-testid')}: "${e.textContent}" sticks out`);
        }
      }
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const [a, ra] = rects[i];
          const [b, rb] = rects[j];
          if (a.contains(b) || b.contains(a)) continue;
          const overlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 0.5 && Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 0.5;
          if (overlap) out.push(`${c.getAttribute('data-testid')}: "${a.textContent}" overlaps "${b.textContent}"`);
        }
      }
    }
    return out;
  });
  assert.deepEqual(problems, []);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 1024, `no horizontal scroll: ${width}`);
}));
