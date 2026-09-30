#!/usr/bin/env node
// Screenshots of the dashboard on the made-up "recipes-app" board (npm run screenshots).
// Builds the fixture board in a throwaway git repository named recipes-app (the header shows the
// repository's name), starts the dashboard on it, and captures at 1440x900 in headless Chromium:
//   docs/design/overview.png        the Overview
//   docs/design/board.png           the Board
//   docs/design/task.png            the task view of #6 (Jade's question)
//   docs/design/overview-dark.png   the Overview with the system in dark mode
// The board and the dashboard share one fixed clock, so the relative times ("2 min ago") are the
// same on every run. Everything is closed and the repository removed afterwards.
// Needs Playwright's Chromium once: npm run setup:ui
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../test/ui/harness.js';
import { startDashboard } from '../src/dashboard/server.js';
import { buildRecipesBoard } from '../test/fixtures/recipes-app.js';

const OUT = fileURLToPath(new URL('../docs/design/', import.meta.url));
/** A fixed local afternoon, so "Shipped today" is filled whatever the time zone. */
const NOW = new Date(2026, 4, 12, 15, 0, 0).getTime();
const VIEWPORT = { width: 1440, height: 900 };

/** An empty git repository `<parent>/recipes-app` with one commit, made without the user's git config. */
function makeRepo(parent) {
  const repo = path.join(parent, 'recipes-app');
  fs.mkdirSync(repo);
  const gitConfig = path.join(parent, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=recipes@example.invalid', '-c', 'user.name=recipes', 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

/**
 * Opens `hash` in a fresh page of `browser` and saves the viewport as docs/design/<name>.png once the
 * live stream is up and the view has drawn `ready`. @returns {Promise<string>} the file written
 */
async function shoot(browser, url, { name, hash = '', ready, colorScheme = 'light' }) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme });
  try {
    const page = await context.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (err) => problems.push(err.message));
    await page.goto(`${url}${hash}`);
    await page.locator(ready).first().waitFor();
    await page.locator('[data-testid="live"][data-state="live"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (problems.length) throw new Error(`${name}: the page reported problems:\n${problems.join('\n')}`);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    return file;
  } finally {
    await context.close();
  }
}

const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-shots-')));
let dash;
let browser;
try {
  const repo = makeRepo(parent);
  const board = buildRecipesBoard(repo, { now: NOW });
  dash = await startDashboard({ board, port: 0, now: () => NOW, watch: false });
  browser = await chromium.launch();
  const shots = [
    { name: 'overview', ready: '[data-testid="agent-card"]' },
    { name: 'board', hash: '#/board', ready: '[data-testid^="card-"]' },
    { name: 'task', hash: '#/task/6', ready: '[data-testid="task-title"]' },
    { name: 'overview-dark', ready: '[data-testid="agent-card"]', colorScheme: 'dark' },
  ];
  for (const shot of shots) {
    const file = await shoot(browser, dash.url, shot);
    console.log(`${path.relative(process.cwd(), file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }
} finally {
  await browser?.close();
  await dash?.close();
  fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
}
