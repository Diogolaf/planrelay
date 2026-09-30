import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { endAgent } from '../../src/core/agents.js';
import { transact } from '../../src/core/store.js';
import { requestTask, withDashboard } from './harness.js';

/** The Ready count in the Board's column header. @param {import('playwright').Page} page */
const readyCount = (page) => page.getByTestId('column-ready').getByTestId('column-count');
/** A locator's text is exactly `n`. */
const exactly = (n) => new RegExp(`^${n}$`);

/** Waits until `check()` holds, on the test's side. @param {() => boolean} check @param {string} what */
async function until(check, what, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Hides or shows the page, as the browser does for a background tab. @param {import('playwright').Page} page @param {boolean} hidden */
const setHidden = (page, hidden) => page.evaluate((value) => {
  Object.defineProperty(document, 'hidden', { value, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: value ? 'hidden' : 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

/** Ends Jade's session, as the SessionEnd hook does; the header's agent count drops with it. @param {import('../../src/core/store.js').Board} board */
function endJade(board) {
  transact(board, (state, reg, at) => {
    endAgent(reg, 'fixture-jade', at);
    return { registry: reg };
  });
}

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

test('a hidden tab gives its live stream back, and catches up when shown again', () => withDashboard(async ({ page, url, board, repo, dash }) => {
  await page.goto(`${url}#/board`);
  const live = page.getByTestId('live');
  await live.filter({ hasText: 'live' }).waitFor();
  await readyCount(page).filter({ hasText: /^\d+$/ }).waitFor();
  const before = Number(await readyCount(page).textContent());
  await until(() => dash.server.eventClients === 1, 'the stream to open');
  await setHidden(page, true);
  await until(() => dash.server.eventClients === 0, 'the hidden tab to close its stream');
  await live.filter({ hasText: 'connecting' }).waitFor();
  requestTask(board, repo, 'Print a recipe card');
  await page.waitForTimeout(500); // well past the watcher's debounce: a stream would have brought it
  assert.equal(Number(await readyCount(page).textContent()), before);
  await setHidden(page, false);
  await until(() => dash.server.eventClients === 1, 'the shown tab to open a stream');
  await readyCount(page).filter({ hasText: exactly(before + 1) }).waitFor({ timeout: 3000 });
  await live.filter({ hasText: '2 agents active · live' }).waitFor();
}));

test('a live render waits while text in the main area is selected', () => withDashboard(async ({ page, url, board }) => {
  await page.goto(url);
  const live = page.getByTestId('live');
  await live.filter({ hasText: '2 agents active · live' }).waitFor();
  const cards = page.getByTestId('agent-card');
  assert.equal(await cards.count(), 2);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(/** @type {Element} */ (document.querySelector('#app h2')));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    /** @type {any} */ (window).shown = document.querySelector('#app')?.firstElementChild;
  });
  endJade(board);
  await live.filter({ hasText: '1 agent active · live' }).waitFor(); // loaded: the header renders at once
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).shown === document.querySelector('#app')?.firstElementChild), true);
  assert.equal(await cards.count(), 2);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await cards.filter({ hasText: 'Jade' }).waitFor({ state: 'detached' });
  assert.equal(await cards.count(), 1);
}));

test('a live render waits while a select in the main area is open', () => withDashboard(async ({ page, url, board }) => {
  await page.goto(url);
  const live = page.getByTestId('live');
  await live.filter({ hasText: '2 agents active · live' }).waitFor();
  await page.evaluate(() => {
    const select = document.createElement('select');
    select.append(new Option('one'), new Option('two'));
    document.querySelector('#app')?.prepend(select);
  });
  const select = page.locator('#app select');
  await select.dispatchEvent('pointerdown');
  endJade(board);
  await live.filter({ hasText: '1 agent active · live' }).waitFor();
  assert.equal(await select.count(), 1); // the main area was not built again
  await select.dispatchEvent('change');
  await select.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('agent-card').count(), 1);
}));

test('a live render keeps the focus on the element with the same data-key', () => withDashboard(async ({ page, url, board, repo }) => {
  await page.goto(url);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  await page.getByTestId('needs-you-row').first().getByTestId('copy').focus();
  const key = await page.evaluate(() => {
    /** @type {any} */ (window).focused = document.activeElement;
    return /** @type {HTMLElement} */ (document.activeElement).dataset.key;
  });
  assert.match(String(key), /^copy-/);
  const ready = page.getByTestId('legend-row').filter({ hasText: 'Ready' }).getByTestId('legend-count');
  const before = Number(await ready.textContent());
  requestTask(board, repo, 'Print a recipe card');
  await ready.filter({ hasText: exactly(before + 1) }).waitFor();
  const [now, same] = await page.evaluate(() => [
    /** @type {HTMLElement} */ (document.activeElement).dataset.key, document.activeElement === /** @type {any} */ (window).focused,
  ]);
  assert.equal(now, key);
  assert.equal(same, false); // a new element: the view was built again
}));

test('a load that changes nothing leaves the main area as it is', () => withDashboard(async ({ page, url, dash }) => {
  await page.goto(url);
  await page.getByTestId('live').filter({ hasText: '2 agents active · live' }).waitFor();
  await page.evaluate(() => { /** @type {any} */ (window).shown = document.querySelector('#app')?.firstElementChild; });
  const reloaded = page.waitForResponse((r) => r.url().endsWith('/api/view'));
  dash.notify(0);
  await reloaded;
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).shown === document.querySelector('#app')?.firstElementChild), true);
}));
