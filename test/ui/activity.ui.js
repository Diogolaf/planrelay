import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { requestTask, withDashboard } from './harness.js';

/** @typedef {import('playwright').Page} Page */

/** A time ago, as a pattern: the fixture's events are 2 to 88 min old. */
const AGO = String.raw`(just now|\d+ min ago|1 h ago)`;

/** Opens the Activity feed at `hash` and waits for its first render. @param {Page} page @param {string} url @param {string} [hash] */
async function openActivity(page, url, hash = '#/activity') {
  await page.goto(`${url}${hash}`);
  await page.getByTestId('activity-heading').waitFor();
}

test('the feed: every shown event, newest first, with a dot per type and the time ago', () => withDashboard(async ({ page, url }) => {
  await openActivity(page, url);
  assert.equal(await page.getByTestId('activity-heading').locator('h1').textContent(), 'Activity');
  const rows = page.getByTestId('activity-row');
  assert.equal(await rows.count(), 27); // the fixture's ring: 3 of its checklist items share one event
  // innerText: a row's sentence, detail and time on lines of their own
  const texts = (await rows.allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
  assert.match(texts[0], new RegExp(`^Jade asked on #${ID.prepTime} Filter by prep time Should "quick" mean under 15 or under 30 minutes\\? ${AGO}$`));
  assert.match(texts[1], new RegExp(`^Jade claimed #${ID.prepTime} Filter by prep time ${AGO}$`));
  assert.match(texts[2], new RegExp(`^Amber checked off an item in #${ID.vegetarian} Vegetarian filter Diet field on recipes ${AGO}$`));
  assert.ok(texts.some((s) => new RegExp(`^Jade completed #${ID.byIngredient} Search by ingredient ${AGO}$`).test(s)));
  assert.ok(texts.some((s) => new RegExp(`^Cobalt released #${ID.photoUpload} Profile photo upload ${AGO}$`).test(s)));
  assert.ok(texts.some((s) => new RegExp(`^Amber suggested #${ID.cachePhotos} Cache recipe photos ${AGO}$`).test(s)));
  assert.match(texts.at(-1) ?? '', new RegExp(`^Amber created #${ID.search} Search ${AGO}$`));

  const types = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-type')));
  assert.deepEqual([...new Set(types)].sort(), ['checked', 'claimed', 'completed', 'created', 'question', 'released', 'suggested']);
  const color = (type) => page.locator(`[data-testid="activity-row"][data-type="${type}"] [data-testid="activity-dot"]`).first()
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(await color('completed'), await color('question'));
  assert.notEqual(await color('claimed'), await color('created'));

  const link = rows.nth(0).getByRole('link');
  assert.equal(await link.getAttribute('href'), `#/task/${ID.prepTime}`);
  const question = rows.nth(0).getByTestId('activity-detail');
  assert.equal(await question.getAttribute('dir'), 'auto');
}));

test('#/activity?task=4: the task\'s timeline only, and a way back to all activity', () => withDashboard(async ({ page, url }) => {
  await openActivity(page, url, `#/activity?task=${ID.byIngredient}`);
  const heading = page.getByTestId('activity-heading');
  assert.equal(await heading.locator('h1').textContent(), `Timeline of #${ID.byIngredient}`);
  assert.equal(await heading.getByRole('link', { name: 'Search by ingredient', exact: true }).getAttribute('href'), `#/task/${ID.byIngredient}`);
  const texts = (await page.getByTestId('activity-row').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
  assert.equal(texts.length, 3);
  assert.match(texts[0], new RegExp(`^Jade completed #${ID.byIngredient} Search by ingredient`));
  assert.match(texts[1], new RegExp(`^Jade claimed #${ID.byIngredient} `));
  assert.match(texts[2], new RegExp(`^Amber created #${ID.byIngredient} `));
  const tab = page.getByRole('navigation', { name: 'Sections' }).locator('[aria-current="page"]');
  assert.equal(await tab.textContent(), 'Activity');

  await heading.getByRole('link', { name: 'Show all activity' }).click();
  await page.waitForURL(/#\/activity$/);
  await page.getByTestId('activity-row').nth(10).waitFor();
  assert.equal(await heading.locator('h1').textContent(), 'Activity');
}));

test('a task with no event in the ring reads "No recent events", and new events arrive live', () => withDashboard(async ({ page, url, board, repo }) => {
  await openActivity(page, url, '#/activity?task=77');
  await page.getByTestId('activity-empty').getByText('No recent events in the activity log.', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('activity-heading').locator('h1').textContent(), 'Timeline of #77');

  await page.goto(`${url}#/activity`);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  const rows = page.getByTestId('activity-row');
  await rows.first().waitFor();
  const before = await rows.count();
  const id = requestTask(board, repo, 'Print a recipe card');
  await rows.first().filter({ hasText: `Amber created #${id} Print a recipe card` }).waitFor();
  assert.equal(await rows.count(), before + 1);
}));
