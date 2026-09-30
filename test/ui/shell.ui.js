import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestTask, withDashboard } from './harness.js';

/** The Ready count in the Board's column header. @param {import('playwright').Page} page */
const readyCount = (page) => page.getByTestId('column-ready').getByTestId('column-count');
/** A locator's text is exactly `n`. */
const exactly = (n) => new RegExp(`^${n}$`);

test('the shell shows the header, the tabs and a live connection', () => withDashboard(async ({ page, url }) => {
  await page.goto(url);
  await page.getByTestId('project-name').filter({ hasText: /./ }).waitFor();
  assert.equal(await page.getByTestId('project-name').textContent(), (await (await fetch(`${url}api/view`)).json()).project);
  for (const tab of ['Overview', 'Board', 'Activity']) await page.getByRole('link', { name: tab, exact: true }).waitFor();
  await page.getByTestId('live').filter({ hasText: '2 agents active · live' }).waitFor();
}));

test('the current tab is highlighted, and a task counts as the Board', () => withDashboard(async ({ page, url }) => {
  const current = page.getByRole('navigation', { name: 'Sections' }).locator('[aria-current="page"]');
  await page.goto(url);
  await current.filter({ hasText: 'Overview' }).waitFor();
  await page.getByRole('link', { name: 'Activity', exact: true }).click();
  await page.waitForURL(/#\/activity$/);
  await current.filter({ hasText: 'Activity' }).waitFor();
  await page.goto(`${url}#/task/5`);
  await current.filter({ hasText: 'Board' }).waitFor();
  assert.equal(await current.count(), 1);
}));

test('search goes to a filtered board', () => withDashboard(async ({ page, url }) => {
  await page.goto(url);
  await page.getByPlaceholder('Search tasks, #id or epic').fill('vegetarian');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/board\?q=vegetarian/);
}));

test('the page makes no request outside its own origin', () => withDashboard(async ({ page, url }) => {
  const foreign = [];
  page.on('request', (r) => { if (!r.url().startsWith(url)) foreign.push(r.url()); });
  await page.goto(url);
  await page.waitForTimeout(500);
  assert.deepEqual(foreign, []);
}));

test('the bundled fonts are the ones in use', () => withDashboard(async ({ page, url }) => {
  await page.goto(url);
  await page.getByTestId('project-name').filter({ hasText: /./ }).waitFor();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replaceAll('"', '')} ${f.weight}`);
  });
  for (const face of ['Instrument Sans 400', 'Instrument Sans 600', 'Instrument Sans 700']) assert.ok(loaded.includes(face), `${face} in ${loaded}`);
}));

test('a change on the board reaches the page without a reload', () => withDashboard(async ({ page, url, board, repo }) => {
  await page.goto(`${url}#/board`);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  await readyCount(page).filter({ hasText: /^\d+$/ }).waitFor();
  const before = Number(await readyCount(page).textContent());
  await page.evaluate(() => { /** @type {any} */ (window).sameDocument = true; });
  requestTask(board, repo, 'Print a recipe card');
  await readyCount(page).filter({ hasText: exactly(before + 1) }).waitFor({ timeout: 3000 });
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).sameDocument), true);
}));

test('the indicator reads offline while the stream is down, and a reconnect reloads the board', () => withDashboard(async ({ page, url, board, repo, dash }) => {
  // No watcher: a change made while the stream is down reaches the page only by the reload on reconnect.
  await page.goto(`${url}#/board`);
  const live = page.getByTestId('live');
  await live.filter({ hasText: '2 agents active · live' }).waitFor();
  await readyCount(page).filter({ hasText: /^\d+$/ }).waitFor();
  const before = Number(await readyCount(page).textContent());
  dash.server.endEvents();
  await live.filter({ hasText: 'offline' }).waitFor();
  requestTask(board, repo, 'Print a recipe card');
  await live.filter({ hasText: 'live' }).waitFor({ timeout: 5000 });
  await readyCount(page).filter({ hasText: exactly(before + 1) }).waitFor({ timeout: 3000 });
}, { dashboard: { watch: false } }));

test('malformed log lines show a banner, dismissed until their count changes', () => {
  let skew = 0;
  return withDashboard(async ({ page, url, board }) => {
    fs.appendFileSync(board.files.events, 'not json\nnot json either\n');
    await page.goto(url);
    const banner = page.getByTestId('banner-bad-lines');
    await banner.filter({ hasText: "2 lines of the board's log could not be read and were skipped." }).waitFor();
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await banner.waitFor({ state: 'detached' });
    await page.reload();
    await page.getByTestId('project-name').filter({ hasText: /./ }).waitFor();
    await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
    assert.equal(await banner.count(), 0);
    // one more bad line: the server counts again once its 30 s cache is past, and the change reaches the page
    skew = 31_000;
    fs.appendFileSync(board.files.events, 'still not json\n');
    await banner.filter({ hasText: "3 lines of the board's log could not be read and were skipped." }).waitFor();
  }, { dashboard: { now: () => Date.now() + skew } });
});
