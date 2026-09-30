# agentboard plan 2: the dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a read-only, live web dashboard for the board, started with `agentboard dashboard` or by asking an agent to "open the board". It follows the approved mockups: Overview as the home page, a Jira-style Board tab, an Activity feed and a task view.

**Architecture:**
- A small Node HTTP server (`src/dashboard/`) serves two things:
  - a prebuilt, dependency-free web UI (`src/dashboard/ui/`, plain ES modules, no build step);
  - a JSON API built by pure view-model functions over the core's state and registry.
- Live updates arrive as server-sent events. They are triggered by filesystem watching, with a 5-second polling fallback.
- The server binds to 127.0.0.1, checks the `Host` header and answers GET only. All board text is rendered as text.

**Tech stack:**
- Node.js 22+, ES modules with JSDoc, `node:test`, zero runtime dependencies.
- The browser UI is vanilla JavaScript modules and CSS, with the fonts bundled.
- Playwright is a dev dependency, for UI tests and screenshots only.

---

## Ground rules for every task

- **No private data, ever.** Only invented names and data (the "recipes-app" example: Amber, Jade, Cobalt) appear in code, tests, fixtures, screenshots and docs. The commit hooks (denylist, identity, gitleaks) enforce this; never bypass them.
- **Tests never contain literal secrets.** Build fake secrets at runtime by concatenation.
- **Line endings:** LF.
- **Running tests:**
  - `npm test` runs the Node suite, with no browser.
  - `npm run test:ui` runs the browser tests. They need `npx playwright install chromium` once.
- **Commits:**
  - Use a conventional prefix.
  - End every commit message with a blank line, then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Stage only your files. Don't push.
- **File-writing tools may turn `\u` escapes into literal invisible characters.** Before committing, scan changed files for unexpected non-ASCII characters.
- **The repository code supersedes this plan's listings** where they differ. Plan 1's modules were hardened after review, so read the real module before building on it.
- **The bar for robustness is normal use.** One or two sessions, `/clear`, killed terminals, Windows, macOS and Linux, a board of up to about 1,000 tasks. Don't build defences for exotic cases (hand-edited internal files, megabyte inputs, double I/O failures).
- **One combined review per task,** covering spec and quality. Fix what would really break.

### How the UI tasks are written

Tasks 9 to 12 build browser views. For those, the plan gives:
- the data contract (the API the view reads);
- the DOM contract (`data-testid` hooks and visible texts);
- the Playwright tests;
- the mockup file to match.

It does **not** give the full markup and CSS. The approved mockups in `docs/design/mockups/` are the visual source of truth: exact colors, spacing and type sizes. Port them into CSS classes and DOM-building code; don't copy inline styles.

## Decisions taken in this plan (recorded in the spec by Task 1)

1. **Frontend:** plain ES modules and CSS served as static files, with no framework, no bundler and no build step. This keeps the package dependency-free and makes the UI easy for users to read and modify. It answers "Frontend framework" in spec §20.
2. **A tenth agent tool, `open_board`,** takes no arguments.
   - It starts the dashboard for the session's board, or reuses a running one, opens the browser and replies with the URL.
   - Plugin users have no `npx agentboard` until the npm package is published (plan 3). This tool is how "open the board" (§11) works for them.
3. **Activity names:** events carry `actorName`, the actor's display name at write time. Activity entries keep it (SCHEMA 3), so the feed stays readable after the registry forgets an agent.
4. **"Last touched file"** for the Now cards is stored on the agent in the registry (`lastFile`, `lastFileAt`) by the PostToolUse hook.
5. **Dead sessions:** the dashboard counts a live agent on its own host whose process no longer exists as ended. That is what housekeeping records at its next write. Such a claim shows as STALLED right away.
6. **Questions to `any`** (the default `to`) are for agents, not the human. They appear as a blocking reason on the card ("Question to any agent"), not in Needs you.
7. **Timeline:** the task view's "Full timeline · N events" and the Activity filter come from the activity ring (the last 500 entries). When the ring no longer reaches the task's creation, the view says "Showing the most recent N events".
8. **Malformed log lines (§16)** are counted by `logHealth(board)`, which leaves out a batch still being written at the end of the log. The dashboard shows a banner with the `agentboard repair` hint.
9. **Search** uses `listTasks`' text filter on the server (`/api/search`), so it matches exactly what `list_tasks` matches.

## File map

```
docs/design/mockups/              approved mockups (reference only; not served)
docs/design/*.png                 screenshots of the real dashboard on the fixture board (Task 13)
src/dashboard/view.js             buildView(): pure view model for Overview, Board, Activity, header
src/dashboard/taskview.js         buildTaskView(): pure view model for one task
src/dashboard/server.js           createDashboardServer(), startDashboard(): HTTP, API, static files, SSE
src/dashboard/watch.js            watchBoard(): fs.watch + polling fallback, debounced
src/dashboard/launch.js           ensureDashboard(), openBrowser(): used by the CLI and open_board
src/dashboard/ui/index.html       the app shell
src/dashboard/ui/app.css          tokens (light and dark), layout, components
src/dashboard/ui/fonts/           Instrument Sans, JetBrains Mono (woff2) + OFL licenses
src/dashboard/ui/format.js        pure formatting helpers (shared with Node tests)
src/dashboard/ui/dom.js           h(): builds DOM nodes; text only, never innerHTML
src/dashboard/ui/app.js           router, data loading, live updates, header
src/dashboard/ui/views/overview.js, board.js, activity.js, task.js
src/cli.js                        + `dashboard` command
src/mcp/tools.js                  + `open_board` tool
skills/agentboard/SKILL.md        + "open the board" row
test/fixtures/recipes-app.js      buildRecipesBoard(): the mockups' made-up board, via real ops
test/dashboard/*.test.js          Node tests (view models, server, watcher, launch, format)
test/ui/*.ui.js                   Playwright tests (npm run test:ui)
scripts/screenshots.mjs           writes docs/design/*.png from the fixture board
```

---

### Task 1: Design references and spec updates (controller)

The controller does this task directly; no subagent is needed.

**Files:**
- Create: `docs/design/mockups/overview.html`, `board.html` and `task.html`, copied from the approved mockups (Main, OptionB, TaskDetail). Also create `docs/design/mockups/README.md`.
- Modify: `docs/specs/2026-09-29-v1-design.md` (§8, §11, §13, §16, §20).

- [ ] **Step 1: Copy the approved mockups into the repository.** Each file holds made-up recipes-app data. Their `[NAME]` placeholder stays. The README says:
  - they are the visual reference for plan 2;
  - they are not served;
  - they load Google Fonts only for viewing, while the product bundles its fonts.
- [ ] **Step 2: Record decisions 1–9 in the spec:**
  - §8: add `open_board` and say "Ten tools".
  - §11: "open the board" maps to `open_board`.
  - §13 Server: add `--dir`, `--no-open`, reuse through `dashboard.json`, and the timeline note.
  - §16: the malformed-lines banner.
  - §20: the frontend decision.
- [ ] **Step 3: Commit** with `docs: plan 2 design references and dashboard decisions`. The denylist hook checks the mockups.

---

### Task 2: Core additions for the dashboard

**Files:**
- Modify: `src/core/store.js` (stamp `actorName`; `logHealth`)
- Modify: `src/core/reduce.js` (activity `actorName`; SCHEMA 3)
- Modify: `src/hooks/run.js` (agent `lastFile`, `lastFileAt` in PostToolUse)
- Modify: `src/core/store.js` `cleanAgent` (drop an unusable `lastFile`/`lastFileAt`)
- Test: `test/core/store.test.js`, `test/core/reduce.test.js`, `test/hooks/run.test.js`

- [ ] **Step 1: Write the failing tests.**

In `test/core/reduce.test.js`:
```js
test('activity entries keep the actor name stored with the event', () => {
  const s = emptyState();
  applyEvent(s, { seq: 1, tx: 1, n: 1, at: 5, type: 'task.created', actor: 'a1', actorName: 'Amber',
    data: { task: { id: 1, kind: 'task', title: 'T', origin: 'agent', createdBy: 'a1', approved: false, rank: 1 } } });
  assert.equal(s.recent[0].actorName, 'Amber');
  applyEvent(s, { seq: 2, tx: 2, n: 1, at: 6, type: 'task.approved', actor: 'a2', data: { id: 1, approved: true } });
  assert.equal(s.recent[1].actorName, null); // no name in the event: null, never undefined
});

test('SCHEMA is 3: activity entries carry actorName', () => {
  assert.equal(SCHEMA, 3);
});
```

In `test/core/store.test.js`:
```js
test('transact stamps each event with its actor display name', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  transact(board, (state, reg, t) => {
    touchAgent(reg, { id: 'a1', folder: repo, seq: state.seq }, t);
    return { registry: reg, events: [
      { type: 'task.created', actor: 'a1', data: { task: { id: 1, kind: 'task', title: 'T', origin: 'agent', createdBy: 'a1', approved: false, rank: 1 } } },
      { type: 'task.released', actor: 'system', data: { id: 1, reason: 'timeout' } },
    ] };
  }, { now: T0 });
  const lines = fs.readFileSync(board.files.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].actorName, 'Amber');
  assert.equal(lines[1].actorName, null);
});

test('logHealth counts malformed lines but not a batch still being written at the end', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  transact(board, () => ({ events: [{ type: 'task.created', actor: 'h', data: { task: { id: 1, kind: 'task', title: 'A', rank: 1 } } }] }), { now: T0 });
  fs.appendFileSync(board.files.events, 'not json\n');
  assert.deepEqual(logHealth(board), { badLines: 1 });
  // the first line of a two-event batch whose second line has not arrived yet: still being written
  fs.appendFileSync(board.files.events, `${JSON.stringify({ seq: 3, tx: 3, n: 2, at: T0, type: 'task.approved', actor: 'h', data: { id: 1, approved: true } })}\n`);
  assert.deepEqual(logHealth(board), { badLines: 1 });
});

test('the registry reader drops an unusable lastFile', () => {
  const repo = tempRepo();
  const board = openBoard(repo);
  fs.mkdirSync(board.dir, { recursive: true });
  fs.writeFileSync(board.files.agents, JSON.stringify({ agents: {
    a1: { id: 'a1', name: 'Amber', color: '#A45F00', lastFile: 42, lastFileAt: 'x' },
    a2: { id: 'a2', name: 'Jade', color: '#17735A', lastFile: 'src/app.js', lastFileAt: T0 },
  } }));
  const reg = readRegistry(board);
  assert.equal(Object.hasOwn(reg.agents.a1, 'lastFile'), false);
  assert.equal(Object.hasOwn(reg.agents.a1, 'lastFileAt'), false);
  assert.equal(reg.agents.a2.lastFile, 'src/app.js');
});
```

In `test/hooks/run.test.js`, adapt to the helpers the file already uses (`hook(...)`, `session(...)` or equivalent):
```js
test('PostToolUse records the last file the agent edited', () => {
  // SessionStart for s1 in repo, then PostToolUse Edit on <repo>/src/filters/diet.js at T0 + MIN
  // expect: readRegistry(board).agents.s1.lastFile === 'src/filters/diet.js', lastFileAt === T0 + MIN
});
```

- [ ] **Step 2: Run them and watch them fail.** Run `node --test test/core/reduce.test.js test/core/store.test.js test/hooks/run.test.js`.

- [ ] **Step 3: Implement.**

In `src/core/reduce.js`:
- `SCHEMA = 3`, with the doc comment "3: activity entries carry actorName".
- Extend the `Activity` typedef with `actorName: string | null`.
- In `applyEvent`, make the `log` closure store the name:
```js
  const actorName = displayName(ev.actorName) ?? null;
  const log = (type, taskId, text) =>
    push(state.recent, { seq: ev.seq, at, type, taskId, actor, actorName, text: snippet(text) }, RECENT_LIMIT);
```

In `src/core/store.js`:
- `stamp(e, seq, tx, n, now, registry)` adds `actorName: getAgent(registry, e.actor)?.name ?? null`. Import `getAgent` from `./agents.js`; `'system'` and unknown actors get null. `prepare` passes its `registry`.
- `logHealth(board)`:
```js
/**
 * Problems a reader can report without the lock (§16): the number of malformed lines in the log,
 * leaving out a batch still incomplete at the very end (a writer may be appending it right now;
 * `repair` reports those). Never writes. @param {Board} board @returns {{ badLines: number }}
 */
export function logHealth(board) {
  const { bad, tail } = applyLines(emptyState(), readLog(board.files.events), { atFileStart: true });
  return { badLines: bad.length - tail };
}
```
- `applyLines` also returns `tail`: the number of lines of the incomplete batch at the end, or 0. At the end: `let tail = 0; if (batch) { bad.push(...batch.lines); tail = batch.lines.length; }`. Existing callers ignore it.
- `cleanAgent` drops `lastFile` unless it is a non-empty string of at most 1,000 characters, and drops `lastFileAt` unless it is a finite number.

In `src/hooks/run.js` `postToolUse`: after `recordTouch`, set the agent's last file:
```js
        const agent = touch(h, reg, state.seq); // move the existing touch call here if needed; one touch per call
        agent.lastFile = file;
        agent.lastFileAt = now;
```
There is only one `touch` per call; reuse the agent it returns.

- [ ] **Step 4: Run the full suite.** Run `npm test`. Expected: everything passes, including the existing test that rebuilds snapshots of an older schema.

- [ ] **Step 5: Commit** with `feat(core): actor names on events and activity, log health, last edited file`.

---

### Task 3: Shared formatting helpers

`src/dashboard/ui/format.js` is plain ES modules with no DOM. Both the browser and the Node tests import it.

**Files:**
- Create: `src/dashboard/ui/format.js`
- Test: `test/dashboard/format.test.js`

- [ ] **Step 1: Write the failing test.**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAgo, duration, ordinal, joinIds, plural, metaText, askLine } from '../../src/dashboard/ui/format.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('timeAgo and duration', () => {
  assert.equal(timeAgo(0), 'just now');
  assert.equal(timeAgo(59_000), 'just now');
  assert.equal(timeAgo(5 * MIN), '5 min ago');
  assert.equal(timeAgo(3 * HOUR + 10 * MIN), '3 h ago');
  assert.equal(timeAgo(49 * HOUR), '2 d ago');
  assert.equal(timeAgo(-5 * MIN), 'just now'); // clock skew never shows the future
  assert.equal(duration(40 * MIN), '40 min');
  assert.equal(duration(20 * HOUR), '20 h');
  assert.equal(duration(30_000), '1 min');
});

test('ordinal, joinIds and plural', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
  assert.equal(joinIds([21]), '#21');
  assert.equal(joinIds([21, 25]), '#21 and #25');
  assert.equal(joinIds([21, 25, 30]), '#21, #25 and #30');
  assert.equal(plural(1, 'agent'), '1 agent');
  assert.equal(plural(3, 'agent'), '3 agents');
});

test('metaText renders the card meta of each column (spec §13 Board)', () => {
  const now = 10 * HOUR;
  assert.equal(metaText({ kind: 'origin', suggestedBy: 'Amber' }, now), 'suggested by Amber');
  assert.equal(metaText({ kind: 'origin', suggestedBy: null }, now), 'created by you');
  assert.equal(metaText({ kind: 'queue', position: 1 }, now), '1st in line');
  assert.equal(metaText({ kind: 'progress', checklist: { done: 3, total: 5 }, lastActivityAt: now - 12 * MIN }, now), '3/5 · 12 min');
  assert.equal(metaText({ kind: 'progress', checklist: null, lastActivityAt: now - 12 * MIN }, now), '12 min');
  assert.equal(metaText({ kind: 'waits', id: 12, backTo: 'Ready' }, now), 'back to Ready when #12 closes');
  assert.equal(metaText({ kind: 'done', at: now - 2 * HOUR }, now), '2 h ago');
  assert.equal(metaText(null, now), '');
});

test('askLine builds the ready-to-copy requests of Needs you', () => {
  assert.equal(askLine({ kind: 'question', taskId: 14 }), 'answer #14: ');
  assert.equal(askLine({ kind: 'approve', ids: [21, 25] }), 'approve #21 and #25');
  assert.equal(askLine({ kind: 'stalled', id: 9 }), 'resume #9');
});
```

- [ ] **Step 2: Run it and watch it fail.** Run `node --test test/dashboard/format.test.js`.

- [ ] **Step 3: Implement.**
```js
/**
 * Formatting shared by the dashboard UI and the Node tests (no DOM, no clock: callers pass `now`).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A span of time, rounded down, at least 1 min: "40 min", "20 h", "3 d". */
export function duration(ms) {
  const t = Math.max(0, ms);
  if (t < HOUR) return `${Math.max(1, Math.floor(t / MIN))} min`;
  if (t < DAY) return `${Math.floor(t / HOUR)} h`;
  return `${Math.floor(t / DAY)} d`;
}

/** How long ago: "just now" under a minute (and for times in the future), else "<duration> ago". */
export function timeAgo(ms) {
  return ms < MIN ? 'just now' : `${duration(ms)} ago`;
}

export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/** "#21", "#21 and #25", "#21, #25 and #30". */
export function joinIds(ids) {
  const tags = ids.map((id) => `#${id}`);
  return tags.length <= 1 ? (tags[0] ?? '') : `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}`;
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A card's meta text (spec §13 Board table), from the view model's `meta`. */
export function metaText(meta, now) {
  if (!meta) return '';
  switch (meta.kind) {
    case 'origin': return meta.suggestedBy ? `suggested by ${meta.suggestedBy}` : 'created by you';
    case 'queue': return `${ordinal(meta.position)} in line`;
    case 'progress': {
      const since = Number.isFinite(meta.lastActivityAt) ? duration(now - meta.lastActivityAt) : '';
      const list = meta.checklist && meta.checklist.total > 0 ? `${meta.checklist.done}/${meta.checklist.total}` : '';
      return [list, since].filter(Boolean).join(' · ');
    }
    case 'waits': return `back to ${meta.backTo} when #${meta.id} closes`;
    case 'done': return Number.isFinite(meta.at) ? timeAgo(now - meta.at) : '';
    default: return '';
  }
}

/** The request to copy into an agent for a Needs-you item (spec §13 Overview). */
export function askLine(item) {
  switch (item.kind) {
    case 'question': return `answer #${item.taskId}: `;
    case 'approve': return `approve ${joinIds(item.ids)}`;
    case 'stalled': return `resume #${item.id}`;
    default: return '';
  }
}
```

- [ ] **Step 4: Run the test and watch it pass.** Run `node --test test/dashboard/format.test.js`.
- [ ] **Step 5: Commit** with `feat(dashboard): shared formatting helpers`.

---

### Task 4: The fixture board

A realistic, made-up board built through the real operations. It is used by the view-model tests, the UI tests and the screenshots, and it matches the mockups' story.

**Files:**
- Create: `test/fixtures/recipes-app.js`
- Test: `test/dashboard/fixture.test.js`

- [ ] **Step 1: Write the failing test.**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBoard, readState, readRegistry } from '../../src/core/store.js';
import { columnOf } from '../../src/core/derive.js';
import { buildRecipesBoard, FIXTURE_IDS } from '../fixtures/recipes-app.js';
import { tempRepo } from '../helpers.js';

test('the recipes-app fixture has every dashboard situation', () => {
  const repo = tempRepo();
  const now = Date.UTC(2026, 8, 30, 15, 0);
  buildRecipesBoard(repo, { now });
  const board = openBoard(repo);
  const state = readState(board);
  const reg = readRegistry(board);
  const col = (id) => columnOf(state.tasks[id], state.tasks);
  assert.equal(col(FIXTURE_IDS.vegetarian), 'in_progress');
  assert.equal(col(FIXTURE_IDS.prepTime), 'blocked'); // question to the human
  assert.equal(col(FIXTURE_IDS.pagination), 'blocked'); // dependency
  assert.equal(col(FIXTURE_IDS.cachePhotos), 'backlog'); // suggestion
  assert.equal(col(FIXTURE_IDS.passwordReset), 'ready');
  assert.equal(col(FIXTURE_IDS.byIngredient), 'done');
  assert.equal(state.tasks[FIXTURE_IDS.photoUpload].assignee !== null, true); // held by an ended session
  const names = Object.values(reg.agents).map((a) => a.name).sort();
  assert.deepEqual(names, ['Amber', 'Cobalt', 'Jade']);
  assert.ok(Object.values(reg.agents).some((a) => a.endedAt != null)); // Cobalt's session ended
  assert.ok(Object.values(state.tasks).every((t) => (t.updatedAt ?? 0) <= now));
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Adapt it to the real ops API, which takes a ctx `{ state, reg, cfg, agentId, now }` and the input; read `src/core/ops.js`.
```js
import { endAgent, getAgent, touchAgent } from '../../src/core/agents.js';
import { DEFAULTS } from '../../src/core/config.js';
import { claimTask, completeTask, createTask, postMessage, updateTask } from '../../src/core/ops.js';
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
 * by a session that ended. Times run from 90 min before `now` to 2 min before it, so "Shipped today"
 * is filled unless the tests run within 90 min after local midnight (the UI test skips that one check then).
 * @param {string} repo @param {{ now?: number }} [opts]
 */
export function buildRecipesBoard(repo, { now = Date.now() } = {}) {
  const board = openBoard(repo);
  let t = now - 90 * MIN;
  const step = (m = 2) => { t += m * MIN; return t; };
  const agents = { amber: 'fixture-amber', jade: 'fixture-jade', cobalt: 'fixture-cobalt' };
  const write = (fn) => transact(board, (state, reg, at) => fn(state, reg, at), { now: step() }).result;
  const op = (who, fn, input) => write((state, reg, at) => {
    touchAgent(reg, { id: who, folder: repo, seq: state.seq }, at);
    const out = fn({ state, reg, cfg: DEFAULTS, agentId: who, now: at }, input);
    return { events: out.events, registry: reg, result: out.result };
  });
  // Register in palette order, so the names are Amber, Jade, Cobalt.
  for (const id of Object.values(agents)) write((state, reg, at) => { touchAgent(reg, { id, folder: repo, seq: state.seq }, at); return { registry: reg }; });

  const { amber, jade, cobalt } = agents;
  op(amber, createTask, { kind: 'epic', title: 'Search', requestedByHuman: true });
  op(amber, createTask, { kind: 'epic', title: 'Filters', parent: 1, requestedByHuman: true });
  op(amber, createTask, { kind: 'epic', title: 'Accounts', requestedByHuman: true });
  op(amber, createTask, { title: 'Search by ingredient', parent: 1, description: 'Typing an ingredient lists every recipe that uses it.', requestedByHuman: true });
  op(amber, createTask, { title: 'Vegetarian filter', parent: 2, labels: ['improvement'], description: 'A toggle that hides recipes with meat or fish.', requestedByHuman: true });
  op(jade, createTask, { title: 'Filter by prep time', parent: 2, description: 'Filter recipes by how long they take.', requestedByHuman: true });
  op(amber, createTask, { title: 'Password reset email', parent: 3, requestedByHuman: true });
  op(amber, createTask, { title: 'Remember me on login', parent: 3, requestedByHuman: true });
  op(cobalt, createTask, { title: 'Profile photo upload', parent: 3, labels: ['ui'], requestedByHuman: true });
  op(amber, createTask, { title: 'Save favorite recipes', requestedByHuman: true });
  op(amber, createTask, { title: 'Cache recipe photos', labels: ['improvement'], description: 'Photos load slowly on repeat visits.' }); // suggestion
  op(jade, createTask, { title: 'Dark mode for the recipe view', labels: ['ui'] }); // suggestion
  op(amber, createTask, { title: 'Search results pagination', parent: 1, dependsOn: [5], requestedByHuman: true });
  op(amber, createTask, { title: 'Fix the unit conversion rounding', labels: ['bug'], requestedByHuman: true });

  op(jade, claimTask, { id: 4 });
  op(jade, postMessage, { taskId: 4, kind: 'comment', text: 'Using the existing ingredient index; no schema change.' });
  op(jade, completeTask, { id: 4, summary: 'Search by ingredient works from the search box, with tests for plurals.' });
  op(amber, claimTask, { id: 14 });
  op(amber, completeTask, { id: 14, summary: 'Rounding now keeps one decimal for grams and none for cups.' });
  op(cobalt, claimTask, { id: 9 });
  op(cobalt, postMessage, { taskId: 9, kind: 'handoff', text: 'Upload form done; next step: resize on the server before saving.' });
  write((state, reg, at) => { endAgent(reg, cobalt, at); return { registry: reg }; });
  op(amber, claimTask, { id: 5 });
  op(amber, updateTask, { id: 5, checklist: [
    { text: 'Diet field on recipes', done: true }, { text: 'Filter in the API', done: true }, { text: 'Toggle in the UI', done: true },
    { text: 'Empty state', done: false }, { text: 'Tests', done: false },
  ] });
  op(jade, claimTask, { id: 6 });
  op(jade, postMessage, { taskId: 6, kind: 'question', to: 'human', text: 'Should "quick" mean under 15 or under 30 minutes?' });
  op(jade, postMessage, { taskId: 5, kind: 'comment', text: 'The prep-time filter will reuse the same toggle row; see #13 too.' });
  // Amber's last edit, as the PostToolUse hook records it (Task 2).
  t = now - 2 * MIN;
  write((state, reg, at) => {
    const a = getAgent(reg, amber);
    a.lastSeen = at; a.lastFile = 'src/filters/diet.js'; a.lastFileAt = at;
    const j = getAgent(reg, jade);
    j.lastSeen = at;
    return { registry: reg };
  });
  return board;
}
```
If an operation refuses (a `BoardError`), fix the order of the steps rather than weakening ops.

- [ ] **Step 4: Run it and watch it pass.**
- [ ] **Step 5: Commit** with `test: the made-up recipes-app board for the dashboard`.

---

### Task 5: The view model

`buildView` is pure: it takes no IO and never reads the clock. The server passes everything in.

**Files:**
- Create: `src/dashboard/view.js`
- Test: `test/dashboard/view.test.js`

**Output shape (the data contract of Tasks 9 to 11):**
```js
{
  project: 'recipes-app',
  now,                                   // the time the view was built (ms)
  seq,                                   // board sequence number, for change detection
  badLines,                              // from logHealth; 0 normally
  activeCount,                           // agents active now (header "N agents active")
  agents: [{ id, name, color, initial, status: 'active' | 'idle',
             pill: 'In progress' | 'Blocked' | 'Idle' | 'No task',
             task: { id, title } | null, checklist: { done, total } | null,
             lastFile: string | null, blockedReason: string | null, lastActivityAt }],  // live agents only, most recent first
  needsYou: {
    count,                               // rows: questions + (approvals ? 1 : 0) + stalled
    questions: [{ kind: 'question', taskId, title, questionId, text, askedBy, at }],
    approvals: { kind: 'approve', ids: [21, 25], items: [{ id, title, suggestedBy }] } | null,
    stalled: [{ kind: 'stalled', id, title, holderName, since, releaseAt }],
  },
  shippedToday: [{ id, title, agentName, doneAt, summary }],   // doneAt >= midnight, newest first
  epics: [{ id, title, depth: 0 | 1, parent, done, total }],   // tree order: rank, sub-epics under their parent
  counts: { backlog, ready, in_progress, blocked, done, suggested },
  nextInLine: [{ position, id, title, epicPath }],             // first 3 of readyQueue
  labels: [{ name, count }],                                   // tasks per label, count desc then name
  cards: [{
    id, title, column, suggested, labels, firstLabel, epicPath, epicIds,   // epicIds: every ancestor epic id
    assignee: { id, name, color } | null,
    stalled: { since } | null,                                  // holder gone: "No agent for 3 h"
    blockers: [{ kind: 'dependency', id } | { kind: 'human' } | { kind: 'agent', name } | { kind: 'any' }],
    meta: { kind: 'origin', suggestedBy } | { kind: 'queue', position } |
          { kind: 'progress', checklist, lastActivityAt } | { kind: 'waits', id, backTo } | { kind: 'done', at } | null,
    rank, doneAt, updatedAt,
  }],                                                           // every task (not epics), board order: column, then rank (Done: newest first)
  activity: [{ seq, at, type, taskId, taskTitle, actorName, text }],      // newest first, shown types only
}
```

- [ ] **Step 1: Write the failing tests.** They run against the fixture board (Task 4), plus small hand-built states for edge rules.
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBoard, readState, readRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { buildView, withDeadEnded, SHOWN_ACTIVITY } from '../../src/dashboard/view.js';
import { buildRecipesBoard, FIXTURE_IDS as ID } from '../fixtures/recipes-app.js';
import { tempRepo } from '../helpers.js';

const NOW = Date.UTC(2026, 8, 30, 15, 0);
const MIDNIGHT = Date.UTC(2026, 8, 30, 0, 0);

function fixtureView(extra = {}) {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  return buildView({ state: readState(board), reg: readRegistry(board), cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT,
    projectName: 'recipes-app', badLines: 0, host: null, alive: () => true, ...extra });
}

test('header and counts', () => {
  const v = fixtureView();
  assert.equal(v.project, 'recipes-app');
  assert.equal(v.activeCount, 2); // Amber and Jade; Cobalt ended
  assert.deepEqual(v.counts, { backlog: 2, ready: 3, in_progress: 2, blocked: 2, done: 2, suggested: 2 }); // #9 stays In progress: its holder is gone, not the claim
});

test('Needs you: the question to the human, the grouped suggestions and the stalled claim', () => {
  const { needsYou: n } = fixtureView();
  assert.equal(n.count, 3);
  assert.deepEqual(n.questions.map((q) => [q.taskId, q.askedBy]), [[ID.prepTime, 'Jade']]);
  assert.deepEqual(n.approvals.ids, [ID.cachePhotos, ID.darkMode]);
  assert.deepEqual(n.approvals.items.map((a) => a.suggestedBy), ['Amber', 'Jade']);
  assert.deepEqual(n.stalled.map((s) => [s.id, s.holderName]), [[ID.photoUpload, 'Cobalt']]);
  assert.ok(n.stalled[0].releaseAt > NOW);
});

test('Now: one card per live agent with its task, checklist, pill and last file', () => {
  const v = fixtureView();
  const amber = v.agents.find((a) => a.name === 'Amber');
  assert.deepEqual(amber.task, { id: ID.vegetarian, title: 'Vegetarian filter' });
  assert.deepEqual(amber.checklist, { done: 3, total: 5 });
  assert.equal(amber.pill, 'In progress');
  assert.equal(amber.lastFile, 'src/filters/diet.js');
  const jade = v.agents.find((a) => a.name === 'Jade');
  assert.equal(jade.pill, 'Blocked');
  assert.equal(jade.blockedReason, 'Waiting for your answer');
  assert.equal(v.agents.some((a) => a.name === 'Cobalt'), false);
});

test('Shipped today, epics, next in line, labels', () => {
  const v = fixtureView();
  assert.deepEqual(v.shippedToday.map((s) => s.id), [ID.rounding, ID.byIngredient]); // newest first
  assert.deepEqual(v.epics.map((e) => [e.title, e.depth]), [['Search', 0], ['Filters', 1], ['Accounts', 0]]);
  const search = v.epics.find((e) => e.id === ID.search);
  assert.deepEqual([search.done, search.total], [1, 4]); // #4 done of #4, #5, #6, #13 (sub-epic tasks count)
  assert.deepEqual(v.nextInLine.map((n) => [n.position, n.id]), [[1, ID.passwordReset], [2, ID.rememberMe], [3, ID.favorites]]);
  assert.deepEqual(v.labels.slice(0, 2), [{ name: 'improvement', count: 2 }, { name: 'ui', count: 2 }]);
});

test('cards: blockers, stalled chip and meta per column', () => {
  const v = fixtureView();
  const card = (id) => v.cards.find((c) => c.id === id);
  assert.deepEqual(card(ID.prepTime).blockers, [{ kind: 'human' }]);
  assert.deepEqual(card(ID.pagination).blockers, [{ kind: 'dependency', id: ID.vegetarian }]);
  assert.deepEqual(card(ID.pagination).meta, { kind: 'waits', id: ID.vegetarian, backTo: 'Ready' });
  assert.deepEqual(card(ID.cachePhotos).meta, { kind: 'origin', suggestedBy: 'Amber' });
  assert.equal(card(ID.cachePhotos).suggested, true);
  assert.deepEqual(card(ID.passwordReset).meta, { kind: 'queue', position: 1 });
  assert.equal(card(ID.vegetarian).meta.kind, 'progress');
  assert.deepEqual(card(ID.vegetarian).meta.checklist, { done: 3, total: 5 });
  assert.ok(card(ID.photoUpload).stalled);
  assert.equal(card(ID.photoUpload).assignee.name, 'Cobalt');
  assert.deepEqual(card(ID.vegetarian).epicIds, [ID.filters, ID.search]);
  assert.equal(card(ID.vegetarian).epicPath, 'Search › Filters');
});

test('activity: newest first, names kept, file edits never shown', () => {
  const v = fixtureView();
  assert.ok(v.activity.length > 5);
  assert.ok(v.activity.every((e, i, all) => i === 0 || all[i - 1].seq > e.seq));
  assert.ok(v.activity.every((e) => SHOWN_ACTIVITY.includes(e.type)));
  const done = v.activity.find((e) => e.type === 'completed' && e.taskId === ID.byIngredient);
  assert.equal(done.actorName, 'Jade');
});

test('a live agent of this host whose process is gone counts as ended', () => {
  const repo = tempRepo();
  buildRecipesBoard(repo, { now: NOW });
  const board = openBoard(repo);
  const reg = readRegistry(board);
  for (const a of Object.values(reg.agents)) { a.host = 'h1'; a.pid = a.name === 'Amber' ? 111 : 222; }
  const eff = withDeadEnded(reg, { host: 'h1', alive: (pid) => pid !== 111, now: NOW });
  const amber = Object.values(eff.agents).find((a) => a.name === 'Amber');
  assert.equal(amber.endedAt, NOW);
  assert.equal(Object.values(reg.agents).find((a) => a.name === 'Amber').endedAt, null); // input untouched
  const v = buildView({ state: readState(board), reg, cfg: DEFAULTS, now: NOW, midnight: MIDNIGHT, projectName: 'p',
    badLines: 0, host: 'h1', alive: (pid) => pid !== 111 });
  assert.equal(v.agents.some((a) => a.name === 'Amber'), false);
  assert.ok(v.needsYou.stalled.some((s) => s.id === ID.vegetarian));
});

test('performance: a 1,000-task board builds in well under 100 ms', () => {
  // Build a state with 1,000 tasks directly with applyEvent (see test/perf.test.js for the pattern)
  // and assert the median of 5 buildView calls is under 100 ms.
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.**
```js
import { getAgent, statusOf } from '../core/agents.js';
import { blockers, byRank, childrenIndex, columnOf, COLUMNS, epicPath, epicProgress, readyQueue } from '../core/derive.js';
import { lastActivity } from '../core/maintenance.js';
import { claimedBy } from '../core/ops.js';
import { boardCounts, needsHuman } from '../core/queries.js';
import { displayName } from '../core/reduce.js';

/** Activity kinds the feed shows (§13 Activity); file edits are never logged as activity. */
export const SHOWN_ACTIVITY = Object.freeze([
  'created', 'suggested', 'approved', 'claimed', 'checked', 'question', 'answer', 'completed', 'released',
  'unblocked', 'dependencies-done', 'auto-released',
]);

/**
 * The registry as the dashboard sees it: a live agent of this host whose process no longer exists
 * counts as ended now, which housekeeping records at its next write (§10). Returns a copy; `reg`
 * is not changed. @param {import('../core/store.js').Registry} reg
 * @param {{ host: string | null, alive: (pid: number) => boolean, now: number }} io
 */
export function withDeadEnded(reg, { host, alive, now }) {
  const agents = Object.fromEntries(Object.entries(reg.agents).map(([id, a]) => {
    const dead = a.endedAt == null && host != null && a.host === host && Number.isInteger(a.pid) && a.pid > 0 && !alive(a.pid);
    return [id, dead ? { ...a, endedAt: now } : a];
  }));
  return { ...reg, agents };
}
```
Then write `buildView(input)` against the contract above. The rules:
- **Holder name:** registry name first (`displayName(getAgent(reg, id)?.name)`), then the task's `assigneeName`, then "an earlier agent". This mirrors queries' `holderName`. Colors come from the registry, with a neutral gray when the agent is unknown.
- **`agents`:** every agent with `endedAt == null` in the effective registry, sorted by `lastSeen` newest first.
  - `status` comes from `statusOf`. `initial` is the first letter of the name.
  - `pill`: `'Idle'` when status is idle; else `'No task'` without a claim; else `'Blocked'` when the task's column is blocked; else `'In progress'`.
  - `blockedReason` is `'Waiting for your answer'` when a blocker is a question to the human; `'Waiting on #N'` for a dependency; `'Waiting for Jade'` or `'Waiting for any agent'` for questions to agents.
  - `lastActivityAt` is `lastActivity(task, reg)` with a task, else `lastSeen`.
- **`needsYou`:** from `needsHuman(state, effectiveReg, cfg, now)`.
  - `approvals` is null when there are none.
  - Each stalled item adds `holderName`.
  - Question `text` is the open question's snippet.
- **`shippedToday`:** tasks with `done && doneAt >= midnight`, sorted by `doneAt` newest first. `agentName` is `completedByName`, falling back to the registry.
- **`epics`:** kind `epic`, top level by `byRank`, each followed by its sub-epics (`parent` equal to its id) by rank. Sub-epics have depth 1. `done` and `total` come from `epicProgress`. An epic whose parent is missing counts as top level.
- **`nextInLine`:** `readyQueue(state.tasks).slice(0, 3)`.
- **`labels`:** count tasks (kind `task`) per label.
- **`cards`:** every kind-`task` task.
  - `epicIds` walks `parent` upward, at most 2 levels and cycle-safe.
  - `blockers` are shown only in Blocked, from `blockers(t, tasks)`. A question to `human` maps to `{kind:'human'}`, to `any` to `{kind:'any'}`, and to an agent id to `{kind:'agent', name}`.
  - `stalled` is set when the holder is gone in the effective registry: `{ since: lastActivity(t, reg) }`.
  - `meta` by column:
    - backlog: `{kind:'origin', suggestedBy: t.origin==='agent' ? name : null}`;
    - ready: queue position;
    - in_progress: checklist and `lastActivity`;
    - blocked: the first dependency blocker gives `{kind:'waits', id, backTo: t.assignee ? 'In progress' : 'Ready'}`, and only questions give null;
    - done: `{kind:'done', at: doneAt}`.
  - Sort by `COLUMNS` order, then rank. Done is sorted newest first.
- **`activity`:** `state.recent` reversed, filtered to `SHOWN_ACTIVITY`.
  - `actorName` is the entry's `actorName`, then `'system'` for the system, then the registry name, then `'an earlier agent'`.
  - `taskTitle` is the current title, or null when the task is gone.

- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm test`.
- [ ] **Step 5: Commit** with `feat(dashboard): view model for overview, board and activity`.

---

### Task 6: The task view model

**Files:**
- Create: `src/dashboard/taskview.js`
- Test: `test/dashboard/taskview.test.js`

**Output shape:**
```js
{
  id, title, kind, column, columnLabel,
  status: { text: 'Blocked · waiting on you' | 'In progress' | 'Ready' | 'Backlog · suggested' | 'Done' | …, column },
  breadcrumb: [{ id, title }],                 // ancestor epics, outermost first
  assignee: { id, name, color, since, gone } | null,   // since: claim start ("has had it for 40 min")
  labels, origin: 'requested by you' | 'suggested by Amber' | 'created by Amber',
  question: { id, text, at } | null,           // the first open question to the human (callout)
  description,
  checklist: { items: [{ text, done }], done, total },
  conversation: [{ id, tag, authorName, authorColor, at, text, relayedBy }],
      // tag: 'CREATED' | 'COMMENT' | 'QUESTION → YOU' | 'QUESTION → <NAME>' | 'QUESTION → ANYONE' | 'ANSWER' | 'HANDOFF' | 'SUMMARY' | 'AUTOMATIC'
      // the first entry is CREATED (from createdAt and the creator's name), then messages oldest first
  details: { status, agent, epic, labels, origin, createdAt },
  dependsOn: [{ id, title, column }], blocks: [{ id, title, column }],
  files: [{ path, agentName }], filesMore: boolean,   // true at FILES_LIMIT ("200+")
  links: [{ title, target, href }],                   // href only for http(s) targets; repo paths get none
  timeline: { count, truncated },                     // from the activity ring (decision 7)
  summary: string | null, completedByName, doneAt,
}
```

- [ ] **Step 1: Write the failing tests** against the fixture. They cover:
  - the breadcrumb of `#5` (Search › Filters);
  - the prep-time question callout with the `QUESTION → YOU` tag;
  - the CREATED entry first;
  - the Cobalt handoff tagged `HANDOFF`;
  - `assignee.gone` for `#9`;
  - `origin` of the suggestion ("suggested by Amber");
  - `dependsOn` and `blocks` between `#13` and `#5`;
  - the files of `#5` if any;
  - `links` with a `javascript:` target never getting an `href` (build that case by hand; ops refuses it, so construct the state directly);
  - `timeline.count` > 0;
  - `buildTaskView(..., 999)` returning null;
  - a malformed id throwing the BoardError from `getTask`.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement** `buildTaskView({ state, reg, cfg, now, id, messages, host, alive })`:
  - It builds on `getTask(state, effectiveReg, id, messages)` from queries.js, with `withDeadEnded` from view.js. It is pure.
  - `href` is set only when `/^https?:\/\//i.test(target)`.
  - `timeline.truncated` is true when the ring is full (`state.recent.length >= RECENT_LIMIT`) and the task's creation is not among the task's entries in the ring.
  - A relayed human message has `authorName: 'You'` and `relayedBy` set to the agent's name.
  - The status texts:
    - `'Blocked · waiting on you'` when a blocker is a question to the human;
    - `'Blocked · waiting on #12'` for a dependency;
    - `'Blocked · question to Jade'` for a question to an agent;
    - otherwise the column label.
    - For the backlog, add `' · suggested'` when the task is an agent suggestion.

- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm test`.
- [ ] **Step 5: Commit** with `feat(dashboard): task view model`.

---

### Task 7: The server

**Files:**
- Create: `src/dashboard/server.js`
- Test: `test/dashboard/server.test.js`

**Contract:**
- `createDashboardServer({ board, now?, host?, alive?, uiDir?, onError? })` returns a `http.Server` that isn't listening yet.
- `startDashboard({ board, port = 0, ...same })` resolves to `{ server, url, port, close }`. It listens on `127.0.0.1` only.
- **Every response** carries:
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: no-referrer`;
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **Host check:** a request whose `Host` header is not exactly `127.0.0.1:<port>` or `localhost:<port>` gets 403, with the text "Forbidden host".
- **Methods:** anything but GET and HEAD gets 405 with `Allow: GET, HEAD`. There are no CORS headers, ever.
- **Routes:**
  - `GET /` serves `ui/index.html`.
  - `GET /ui/<path>` serves static files under `uiDir` (default `src/dashboard/ui`).
    - The path is decoded once, then rejected if it has `..`, a backslash, NUL, a drive letter or an absolute path.
    - After `path.resolve`, it must stay inside `uiDir`.
    - Allowed extensions: `.html .js .css .woff2 .svg .txt`, with correct content types (`text/javascript; charset=utf-8` for `.js`).
    - Anything else gets 404.
    - `Cache-Control: no-cache`.
  - `GET /api/view` returns `buildView(...)` as JSON.
    - It uses `readState`, `readRegistry`, and a config reloaded on every request with `loadConfig(board.configRoot)`.
    - `badLines` comes from `logHealth`, at most once every 30 s, cached.
    - `midnight` is the server's local midnight for `now`.
    - The project name is `board.projectName`.
    - `Cache-Control: no-store`.
  - `GET /api/task/<n>` returns `buildTaskView(...)` with `readMessages(board, n)`. A missing task gets 404 with JSON `{ error }`, and a malformed id gets 400 with JSON `{ error }`.
  - `GET /api/search?q=<text>` returns `{ ids, total }` from `listTasks(state, reg, { text: q, limit: 200 })`, and empty for an empty `q`.
  - `GET /api/ping` returns `{ app: NAME, board: <sha256 of board.dir, first 16 hex> }`. It never includes paths.
  - `GET /api/events` is Server-Sent Events. It sends `retry: 2000`, then `event: change` with `data: <seq>` whenever `notify()` is called (Task 8 wires the watcher), and a comment heartbeat every 25 s. Clients are dropped when their connection closes.
  - Anything else gets 404.
- **Failures:** a failure inside a handler is logged with `logError(board, 'dashboard …', err)` and answered with 500 and a short JSON error. The server never crashes.
- The returned object exposes `notify(seq)` for the watcher.

- [ ] **Step 1: Write the failing tests.** Use real HTTP against a started server on port 0, with the fixture board. Cover:
  - `GET /` returns 200 with HTML, and the CSP header is present;
  - a foreign Host (`evil.example:PORT`, `127.0.0.1:1`) gets 403;
  - `POST /api/view` gets 405;
  - `/api/view` JSON has `project === basename of the repo` and the counts;
  - `/api/task/5` has its title, `/api/task/999` gets 404, `/api/task/abc` gets 400;
  - `/ui/../package.json`, `/ui/%2e%2e/package.json`, `/ui/..%5cpackage.json` and `/ui/app.css.map` get 404;
  - `/ui/format.js` returns 200 with a JavaScript content type;
  - `/api/search?q=vegetarian` returns `{ ids: [5], total: 1 }`;
  - `/api/ping` has no path in the body;
  - SSE: connect, call `notify(42)`, and receive `event: change` with `data: 42`;
  - a handler failure (stub `buildView` to throw via an injectable option) gets 500 and a line in errors.log, and the server still answers the next request.

  Send custom Host headers with `http.request` and `headers: { host }`.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement** `src/dashboard/server.js` per the contract, with Node's `http` and `fs` only.
- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm test`.
- [ ] **Step 5: Commit** with `feat(dashboard): local read-only HTTP server with API and live events`.

---

### Task 8: Watching the board, the CLI command and `open_board`

**Files:**
- Create: `src/dashboard/watch.js`, `src/dashboard/launch.js`
- Modify: `src/cli.js` (the `dashboard` command), `src/mcp/tools.js` (the `open_board` tool), `skills/agentboard/SKILL.md` (the "open the board" row)
- Test: `test/dashboard/watch.test.js`, `test/dashboard/launch.test.js`, `test/cli.test.js`, `test/mcp/tools.test.js`, `test/plugin.test.js`

**Contracts:**
- `watchBoard(board, onChange, { pollMs = 5000, debounceMs = 150 })` returns `{ close }`.
  - It uses `fs.watch(board.dir)` and reacts to changes of `events.jsonl` and `agents.json`, or to a null filename.
  - It also polls every `pollMs`, comparing `fileSize(events)` and the `mtimeMs` of `agents.json`.
  - Bursts are debounced into one call. `agents.json` is rewritten on every hook call.
  - If `board.dir` does not exist yet, it polls only and starts watching once the directory appears.
  - It never throws out of a callback.
- `startDashboard` is wired to `watchBoard`: every change calls `notify(readState(board).seq)`.
- `dashboard.json` is written in `board.dir` when the dashboard starts: `{ pid, port, startedAt, board: <same id as /api/ping> }`. The write is atomic. The file is removed on a clean exit (SIGINT, SIGTERM, `exit`) only while it still names this pid.
- `ensureDashboard(board, { spawn?, open?, sleep?, now? })` is synchronous, because MCP tool handlers are synchronous.
  - It reads `dashboard.json`. If its pid is alive (`pidAlive`), it opens the URL and returns `{ url, reused: true }`.
  - Otherwise it spawns `process.execPath [cliPath, 'dashboard', '--dir', board.repoRoot, '--no-open']`: detached, `stdio: 'ignore'`, `windowsHide: true`, then `unref()`.
  - It waits up to 5 s (polling every 100 ms with `sleepSync`) for a `dashboard.json` naming the new pid. Then it opens the URL and returns `{ url, reused: false }`.
  - On a timeout it throws a `BoardError` saying the dashboard did not start and suggesting `agentboard dashboard` in a terminal.
- `openBrowser(url)` runs:
  - on win32: `rundll32 url.dll,FileProtocolHandler <url>`;
  - on darwin: `open <url>`;
  - on others: `xdg-open <url>`.

  It is detached and ignored, and never throws. The URL is always `http://127.0.0.1:<port>/`, built by the tool, never taken from the board.
- **CLI:** `agentboard dashboard [--port N] [--dir PATH] [--no-open]`.
  - It opens the board of `--dir`, or else of the current folder. `CLAUDE_PROJECT_DIR` is used only when `--dir` is not given.
  - It reuses a running dashboard of the same board: it prints its URL, opens it and exits 0.
  - Otherwise it starts one, prints `agentboard dashboard for <project>: http://127.0.0.1:<port>/ (Ctrl+C to stop)` and opens the browser unless `--no-open`.
  - A bad `--port` prints the usage and exits 1.
- **MCP tool:** `open_board`, with description "Open the board's dashboard in the browser and return its URL." and an empty input schema (`additionalProperties: false`).
  - Its reply is "The board is open at http://127.0.0.1:PORT/." or "… is already open at …".
  - It does not register or touch an agent.
  - Update the "nine tools" wording in the code and the tests.
- **Skill:** add a row: "open the board" or "show me the board" → call `open_board`, then tell the human the URL.

- [ ] **Step 1: Write the failing tests.**
  - **Watcher:**
    - a transact on the board triggers exactly one `onChange` within 1 s, for a burst of 5 writes (debounce);
    - polling alone works when `fs.watch` is disabled (inject a flag);
    - a board dir created after start is picked up;
    - `close()` stops everything, so the test process exits.
  - **Launch:**
    - with an injected `spawn` that writes `dashboard.json` for pid 4242 and an `alive` that is true for 4242, `ensureDashboard` returns `{ reused: false }` and opens the URL (injected `open`);
    - a second call returns `{ reused: true }`;
    - a stale `dashboard.json` (dead pid) starts a new one;
    - a spawn that never writes the file throws the BoardError after the (injected) timeout.
  - **CLI:** spawn `node src/cli.js dashboard --no-open --port 0 --dir <fixture repo>`, read the URL from stdout, `GET /api/ping` answers, kill the child, and `dashboard.json` is gone.
  - **MCP:** `tools/list` has 10 tools including `open_board`. With `ensureDashboard` injected through `who` or a module seam, the reply contains the URL.
  - **Plugin test:** the skill mentions `open_board`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and watch them pass.** Then run `npm test`.
- [ ] **Step 5: Commit** with `feat(dashboard): live watching, the dashboard command and the open_board tool`.

---

### Task 9: UI foundation: shell, tokens, fonts, router, header, live updates, browser tests

**Files:**
- Create:
  - `src/dashboard/ui/index.html`, `app.css`, `dom.js`, `app.js`;
  - `src/dashboard/ui/fonts/` (woff2 files and license texts);
  - `test/ui/harness.js`, `test/ui/shell.ui.js`.
- Modify: `package.json`. Add the devDependency `playwright` and the script `"test:ui": "node --test \"test/ui/**/*.ui.js\""`. `npm test` must not pick up `*.ui.js`.

**Fonts:**
- Instrument Sans (400, 500, 600, 700) and JetBrains Mono (400, 500), latin subset, woff2.
- Both are OFL. Take the files from the `@fontsource/instrument-sans` and `@fontsource/jetbrains-mono` npm packages: `npm pack` them in a temp folder, then copy only the latin woff2 files and each package's license file into `src/dashboard/ui/fonts/`.
- Don't add those packages as dependencies.
- Load the fonts with `@font-face` in `app.css`, with `font-display: swap`.
- No request may go anywhere but the dashboard's own origin; the CSP enforces it.

**`dom.js` contract:**
```js
/** h('div', { class: 'card', 'data-testid': 'x', onclick: fn, title: '…' }, child, 'text', [more]) → HTMLElement.
 * Strings become text nodes (never HTML). Attributes: class, id, data-*, aria-*, role, title, href, target, rel, type,
 * value, tabindex, dir, disabled; on* are listeners; style is never accepted (use classes; dynamic widths via
 * el.style.setProperty in view code). null/false children are skipped. */
export function h(tag, attrs, ...children) { … }
export function clear(el) { … }
```
Board text is always rendered as text nodes. Descriptions and messages get `dir="auto"` and the class `bidi` (`unicode-bidi: isolate`). A `href` is set only by view code, and only from view-model fields meant for it: task links in the app's own routes, and `links[].href`, which is already restricted to http(s). External links get `target="_blank" rel="noopener noreferrer"`.

**`app.js` contract:**
- **Routes** are hash-based:
  - `#/` is the Overview;
  - `#/board?epic=&agent=&label=&group=&q=&done=all` is the Board;
  - `#/activity?task=` is Activity;
  - `#/task/<id>` is the task view.
- **Data:**
  - It loads `/api/view` on start, on every SSE `change`, and every 60 s as a safety net.
  - It re-renders relative times every 30 s without refetching.
  - The task view loads `/api/task/<id>` on open and on each change.
- **Live indicator:**
  - "N agents active · live" (a green dot) while the `EventSource` is open.
  - "offline" (a gray dot) after an `error` event, until it reconnects.
- **Header** (spec §13 Header): the logo mark, "agentboard", "/", the project name, the tabs Overview · Board · Activity (the current tab is highlighted), the search box and the live indicator.
  - Typing in search and pressing Enter goes to `#/board?q=<text>`.
- **Malformed lines:** when `badLines > 0`, a banner under the header reads "N lines of the board's log could not be read. Run `agentboard repair` to rebuild the board." (`data-testid="banner-bad-lines"`).
- **Themes:** light and dark tokens in `app.css` via `prefers-color-scheme`. The light tokens are those of the mockups. The dark tokens redefine the same names.

**Browser harness (`test/ui/harness.js`):** `withDashboard(async ({ page, url, board, repo }) => { … })`.
- It builds the fixture in a temp repo with `buildRecipesBoard(repo, { now: Date.now() })`.
- It calls `startDashboard({ board, port: 0 })`, launches headless Chromium with a 1440×900 viewport, and closes everything afterwards.
- It also collects console errors and failed requests, and fails the test if there are any.

**Tests (`test/ui/shell.ui.js`):**
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDashboard } from './harness.js';

test('the shell shows the header, the tabs and a live connection', () => withDashboard(async ({ page, url }) => {
  await page.goto(url);
  await page.getByTestId('project-name').filter({ hasText: /./ }).waitFor();
  assert.equal(await page.getByTestId('project-name').textContent(), (await (await fetch(`${url}api/view`)).json()).project);
  for (const tab of ['Overview', 'Board', 'Activity']) await page.getByRole('link', { name: tab, exact: true }).waitFor();
  await page.getByTestId('live').filter({ hasText: '2 agents active · live' }).waitFor();
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

test('a change on the board reaches the page without a reload', () => withDashboard(async ({ page, url, board }) => {
  await page.goto(url);
  await page.getByTestId('live').filter({ hasText: 'live' }).waitFor();
  // write: a new human-requested task through ops (use the same helper pattern as the fixture), then:
  // the Board tab count for Ready goes up within 3 s
}));
```

- [ ] **Step 1: Install and write the tests.** Run `npm install --save-dev playwright` and `npx playwright install chromium`, then write the harness and the tests.
- [ ] **Step 2: Run `npm run test:ui`** and watch them fail.
- [ ] **Step 3: Implement** the shell, `dom.js`, `app.js`, the header, the tokens and the fonts. Views may render a placeholder until Tasks 10 to 12.
- [ ] **Step 4: Check both suites.** Run `npm run test:ui` and `npm test`; both must pass.
- [ ] **Step 5: Commit** with `feat(dashboard): UI shell, header, live updates and browser tests`.

---

### Task 10: Overview

Match `docs/design/mockups/overview.html` (spec §13 Overview). The data comes from `/api/view`. See Task 5 for the contract.

**Files:**
- Create: `src/dashboard/ui/views/overview.js`
- Modify: `src/dashboard/ui/app.css`, `src/dashboard/ui/app.js`
- Test: `test/ui/overview.ui.js`

**DOM contract:**
- `needs-you` is the section, hidden when `needsYou.count === 0`.
  - The heading holds a count badge (`needs-you-count`) and the note "The dashboard only shows. To act, ask any agent."
  - Each row is `needs-you-row` and contains:
    - a kind chip with the text `QUESTION`, `APPROVE` or `STALLED`;
    - the title;
    - a one-line detail. For a question it is the question text and "asked by Jade · 11 min ago". For approvals it lists the titles. For stalled it reads "Cobalt's session ended · released automatically in 21 h".
    - an "Ask:" box (`ask-text`) with `askLine(...)` and a copy button (`copy`). The button copies with `navigator.clipboard.writeText` and shows "Copied" for 2 s.
- `now` holds one `agent-card` per agent. Each card shows:
  - the avatar with the initial, colored by `color`;
  - the name and the pill;
  - `#id` and the title linking to `#/task/<id>`;
  - the checklist bar with "checklist 3/5";
  - the last file in monospace, or the blocked reason;
  - `timeAgo`.
- The empty state is "No agent is working right now."
- `shipped-today` lists `#id`, the title, the agent, the time ago and the summary. It is hidden when empty.
- `epics` shows each epic with `done/total`, a progress bar, and indentation plus a `sub-epic` tag for depth 1. The "See all" link goes to `#/board`. Clicking an epic goes to `#/board?epic=<id>`.
- `where-the-work-is` is the stacked bar, with segments sized by count and a legend row per column (color, name, count).
- `next-in-line` shows the first three Ready tasks, with the position, `#id`, the title and the epic path, under the note "the next free agent takes the first one".

**Tests (`test/ui/overview.ui.js`),** on the fixture:
- **Needs you** has 3 rows. The question row's ask text is `answer #6: `. Clicking copy puts that text on the clipboard; grant `clipboard-read` and `clipboard-write` in the context.
- **The approve row** reads `approve #11 and #12`. **The stalled row** reads `resume #9` and mentions Cobalt.
- **Now** shows Amber with "In progress", "checklist 3/5" and `src/filters/diet.js`, and Jade with "Blocked" and "Waiting for your answer".
- **Shipped today** lists #14 and #4, in that order. Skip this check when the test runs within 90 minutes after local midnight: the fixture completed them before midnight then.
- **Epics** lists Search, then the indented Filters with its `sub-epic` tag, then Accounts.
- **Next in line** shows 1 #7, 2 #8 and 3 #10.
- **The stacked bar** has 5 legend rows with the counts 2, 3, 2, 2 and 2.

- [ ] **Step 1: Write the tests.** Run them and watch them fail.
- [ ] **Step 2: Implement the view.** Check it visually against the mockup with a screenshot. Spacing, type and color come from the mockup.
- [ ] **Step 3: Run both suites.** Run `npm run test:ui` and `npm test`.
- [ ] **Step 4: Commit** with `feat(dashboard): overview`.

---

### Task 11: Board

Match `docs/design/mockups/board.html` (spec §13 Board).

**Files:**
- Create: `src/dashboard/ui/views/board.js`
- Modify: `src/dashboard/ui/app.css`
- Test: `test/ui/board.ui.js`

**DOM contract:**
- **Sidebar**, three groups. Every entry is a link that sets a filter in the hash, and the selected one is highlighted.
  - **Epics:** "All tasks" with the total, then every epic with `done/total` and a thin bar; sub-epics are indented.
  - **Agents:** the avatar, the name and the current `#id`, plus a "No agent" entry counting the stalled cards.
  - **Labels:** chips with counts.
- **Needs-you strip** (`needs-strip`), hidden when empty:
  - "N things need you";
  - chips: "#6 question from Jade", "2 suggestions to approve", "#9 no agent for 1 h" (the duration comes from the data);
  - the link "See what to ask", which goes to `#/`.
- **Toolbar:**
  - the title "Board";
  - the dropdowns Epic, Agent, Label and Group by (none, epic, agent), as native `<select>` elements styled like the mockup;
  - the note "Done shows the last 7 days".
- **Columns** (`column-<name>`): a header with a color dot, the name in capitals and the count, then the cards.
  - **Backlog and Ready** show the first 20 by rank, then "+ N more" (a button that expands).
  - **Done** shows the last 7 days (`doneAt >= now − 7 d`) and "See all N", which sets `done=all`.
  - **In progress and Blocked** show everything.
- **Card** (`card-<id>`):
  - `#id` in monospace, the `suggested` badge, and the first label on the right;
  - the title, linking to `#/task/<id>`;
  - the epic path with a small square;
  - the blocker chips: "Waiting on #12", "Waiting on you", "Question to Jade", "Question to any agent";
  - the stalled chip "No agent for 1 h" (the duration comes from the data);
  - a footer with the avatar and name when assigned, plus `metaText(meta, now)`.
- **Group by epic or agent** shows horizontal swimlanes, one row of five columns per group, with a lane header. Tasks without an epic go to "No epic"; unassigned tasks go to "Unassigned".
- **Filters** combine: `epic` matches `card.epicIds.includes(epic)`; `agent` matches `assignee.id`, or `none` for stalled; `label`; and `q`, which keeps only the ids returned by `/api/search?q=`.
- **Empty filter result:** "No tasks match these filters." with a "Clear filters" link.

**Tests (`test/ui/board.ui.js`),** on the fixture:
- **Column counts** are Backlog 2, Ready 3, In progress 2, Blocked 2 and Done 2.
- **Card #11** has the `suggested` badge and "suggested by Amber".
- **Card #7** has "1st in line".
- **Card #13** shows "Waiting on #5" and "back to Ready when #5 closes".
- **Card #6** shows "Waiting on you".
- **Card #9** shows "No agent for" and Cobalt.
- **Card #5** shows "3/5".
- **The sidebar epic "Filters"** leaves only #5 and #6 visible. **The agent "Jade"** leaves only #6. **The label `ui`** leaves only #9 and #12.
- **`#/board?q=vegetarian`** shows only #5.
- **Group by epic** shows lanes "Search", "Filters", "Accounts" and "No epic".
- **Clicking a card title** navigates to `#/task/<id>`.

- [ ] **Step 1: Write the tests.** Run them and watch them fail.
- [ ] **Step 2: Implement the view.** Check it visually against the mockup.
- [ ] **Step 3: Run both suites.**
- [ ] **Step 4: Commit** with `feat(dashboard): board`.

---

### Task 12: Activity and task view

Match `docs/design/mockups/task.html` (spec §13 Task view and Activity).

**Files:**
- Create: `src/dashboard/ui/views/activity.js`, `src/dashboard/ui/views/task.js`
- Modify: `src/dashboard/ui/app.css`
- Test: `test/ui/task.ui.js`, `test/ui/activity.ui.js`

**Activity DOM contract:**
- `activity-row` is a reverse-chronological row with a colored dot per type.
  - Its text reads like "Jade completed #4 Search by ingredient" and ends with the time ago.
  - The verbs are created, suggested, approved, claimed, "checked off", asked, answered, completed, released, "auto-unblocked", "auto-released". For `dependencies-done` the text is "dependencies of #N are done".
- With `?task=<id>`, the feed shows that task only, with the heading "Timeline of #N" and a link "Show all activity".

**Task view DOM contract:**
- **Breadcrumb:** Board › epic › sub-epic › `#id`.
- **Title:** the title with its `#id`.
- **Meta row:**
  - the status pill with its reason;
  - the agent avatar with "Jade has had it for 40 min", or "Cobalt's session ended" when gone;
  - the label chips;
  - the origin.
- **Question callout** (`question-callout`), shown when a question to the human is open:
  - "QUESTION FOR YOU · 11 MIN AGO";
  - the text, with `dir="auto"`;
  - "To answer, ask any agent:" with the copyable `answer #6: `.
- **Main column:**
  - Definition of done: the description with `dir="auto"`, keeping line breaks, as text;
  - Checklist "3 of 5", with checked and open items;
  - Conversation, oldest first: an avatar, the author, the tag, the time ago and the text. A relayed message shows "You (relayed by Jade)".
- **Sidebar cards:**
  - Details: Status, Agent (with duration), Epic, Labels, Origin, Created;
  - Dependencies: DEPENDS ON and BLOCKS, each with a status pill;
  - Files touched: the count, then the path and agent per row;
  - Links: the task's links, where external ones open in a new tab and repo paths show as monospace text, plus "Full timeline · N events", which goes to `#/activity?task=<id>`. When truncated, it reads "Showing the most recent N events".
- **Missing task:** a 404 from the API renders "Task #N does not exist." with a link back to the Board.

**Tests,** on the fixture:
- **#6** shows the question callout with `answer #6: ` and a QUESTION → YOU entry.
- **#5** has the breadcrumb "Board › Search › Filters › #5", "Checklist 3 of 5", "Amber has had it for", a comment from Jade and BLOCKS #13.
- **#9** has a HANDOFF entry from Cobalt and "Cobalt's session ended".
- **#999** reads "Task #999 does not exist."
- **Activity** has rows. With `?task=4` it shows only #4's timeline, including "Jade completed #4".
- **Untrusted text is inert.** Add a task through ops whose title is `<img src=x onerror=alert(1)>` and whose description holds a right-to-left override. The title renders as literal text (no `img` element in the DOM), and no dialog opens.

- [ ] **Step 1: Write the tests.** Run them and watch them fail.
- [ ] **Step 2: Implement both views.** Check them visually against the mockup.
- [ ] **Step 3: Run both suites.**
- [ ] **Step 4: Commit** with `feat(dashboard): activity feed and task view`.

---

### Task 13: Screenshots, dark theme check and a real-session check

**Files:**
- Create: `scripts/screenshots.mjs`, and `docs/design/overview.png`, `board.png`, `task.png`, `overview-dark.png`
- Modify: `package.json` (the script `"screenshots": "node scripts/screenshots.mjs"`)

- [ ] **Step 1: Write the screenshot script.**
  - It builds the fixture board with a fixed `now`, starts the dashboard, opens Overview, Board and `#/task/6` at 1440×900, and shows Overview again with `colorScheme: 'dark'`.
  - It writes the PNGs to `docs/design/`, then closes everything.
  - The screenshots must contain only fixture data. Check them visually before committing, and let the denylist hook scan the commit.
- [ ] **Step 2: Run it and review each image** against its mockup. Fix any visual gap in `app.css` or the views, and re-run until the images match the mockups' layout and hierarchy.
- [ ] **Step 3: Check at 1024 px.** The Board and the Overview stay usable at a 1024 px width, with no overlapping text. Add one Playwright test at 1024×768 that checks that no card is cut off.
- [ ] **Step 4: Do a real-session check** (headless, as in plan 1 Task 19). Use a scratch copy of the plugin and `--setting-sources project,local --strict-mcp-config`.
  - Ask the agent to "open the board".
  - Confirm that `open_board` started a dashboard, whose `dashboard.json` exists in the board dir, and that `GET /api/ping` answers.
  - Confirm that a second "open the board" reuses it.
  - Stop it afterwards.
  - Record the cost.
- [ ] **Step 5: Run both suites and the leak scan.** Run `npm test`, `npm run test:ui` and `npm run check:leaks`.
- [ ] **Step 6: Commit** with `docs: dashboard screenshots on the made-up board`.

---

## Self-review against the spec

| Spec | Where |
|---|---|
| §13 header: logo, project, tabs, search, live indicator | Task 9 |
| §13 Overview: Needs you (QUESTION, APPROVE, STALLED, copyable requests), Now, Shipped today, Epics, Where the work is, Next in line | Tasks 5, 10 |
| §13 Board: sidebar, needs-you strip, toolbar with Group by, five columns, card fields and meta, limits | Tasks 5, 11 |
| §13 Activity: feed, colored dots, event kinds, filter by task, no file edits | Tasks 2, 5, 12 |
| §13 Task view: breadcrumb, meta row, question callout, definition of done, checklist, conversation tags, sidebar cards | Tasks 6, 12 |
| §13 Visual language: bundled fonts (no CDN), light tokens, column colors, agent colors, dark theme, 1280+ and 1024 px | Tasks 9, 13 |
| §13 Server: 127.0.0.1, free port or `--port`, Host check, GET only, no CORS, SSE with fs watching and 5 s polling, text-only rendering, bidi isolation, safe links | Tasks 7, 8, 9, 12 |
| §11 "open the board" | Task 8 (`open_board`) |
| §16 malformed lines reported by the dashboard; dashboard not running has no effect on agents | Tasks 2, 9; the dashboard is a separate process |
| §17 dashboard API tests (including a foreign Host) and screenshot tests on fixture data | Tasks 7, 9–13 |
| Plan 1 carry-overs: activity names, `listTasks` 200 cap (the view reads `state.tasks` directly), per-task timeline, malformed-line count, last touched file, dead sessions, questions to `any`, `--dir`, watcher debounce, numeric `epic` (the UI filters client-side by id) | Tasks 2, 5, 6, 8, 11 |

Not in this plan (plan 3): npm packaging and `files` allowlist update for `src/dashboard/ui/fonts`, CI running `test:ui` on Linux, README with screenshots.

## Execution notes

- **Task 1 (done):** the mockups are in `docs/design/mockups/` as canvas templates (markup with `{{…}}` bindings plus a data script at the bottom; they do not render on their own). The spec records decisions 1–9.
- **Task 2 (done, approved):** SCHEMA 3 rebuilds older boards by replay; `logHealth` never flags a batch a writer is still appending.
- **Must-do for Task 9 (banner):** `repair` rebuilds the derived files but never removes bad lines from `events.jsonl`, so the banner must not present repair as the fix. Wording: "N lines of the board's log could not be read and were skipped.", with a dismiss button remembered per count in `localStorage` (a new bad line shows it again). Wrap every `localStorage` access in try/catch.
