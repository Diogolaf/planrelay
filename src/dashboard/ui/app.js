import { h } from './dom.js';
import { plural } from './format.js';
import { overview } from './views/overview.js';

/**
 * The dashboard app (spec section 13): hash routes, data loading, live updates over server-sent
 * events, the header, the live indicator and the malformed-lines banner. The views render the main
 * area (VIEWS).
 *
 * Routes: `#/` Overview; `#/board?epic=&agent=&label=&group=&q=&done=all` Board; `#/activity?task=`
 * Activity; `#/task/<id>` the task view (its tab is Board). Anything else shows the Overview.
 *
 * Data:
 * - `/api/view` loads at start, on every event-stream `open` (so changes made while the stream was
 *   down show at once), on every `change`, and every 60 s as a safety net. Every `change` reloads,
 *   even one whose seq repeats: a rewrite of the agent registry alone (hooks, on every tool call)
 *   keeps the board's seq, and the Now cards need it.
 * - The task view loads `/api/task/<id>` when it opens and at each of those times.
 * - Every 30 s the current view is rendered again with the same data, for its relative times.
 * - Loads never overlap: a load asked for during one runs once more after it, so the last answer
 *   shown is never an old one.
 * - A failed load keeps what is shown; the next open, change or refresh tries again.
 *
 * The clock: the server's `now` at the last load plus the time since then on this browser's clock,
 * so relative times agree with the server even when it runs on a fixed clock (screenshots).
 *
 * @typedef {'overview' | 'board' | 'activity' | 'task'} RouteName
 * @typedef {{ name: RouteName, tab: 'overview' | 'board' | 'activity', params: Record<string, string>, id: number | null }} Route
 *   params: the hash's query as strings (#/board?epic=3 gives { epic: '3' }); id: the task view's task
 * @typedef {{ id: number, data: any, error: string | null }} TaskLoad
 *   data: /api/task/<id> once loaded, else null; error: the server's message for a missing task
 * @typedef {{ view: any, route: Route, now: number, task: TaskLoad | null }} ViewContext
 *   view: /api/view; task: on the task route only
 * @typedef {(ctx: ViewContext) => Node | Node[]} View
 *   A view returns the main area's content. It is called again on every load and every 30 s, so it
 *   keeps no state in the DOM that a render would lose. Board text goes in as text (dom.js h()).
 */

const REFRESH_MS = 60_000;
const TICK_MS = 30_000;
/** Wait before opening a new event stream when the browser gave up on the last one. */
const RECONNECT_MS = 5_000;
/** localStorage key prefix of the dismissed malformed-lines count, per project. */
const DISMISSED_KEY = 'agentboard.badLinesDismissed:';
const COLUMNS = [['backlog', 'Backlog'], ['ready', 'Ready'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];

/**
 * The route of a location hash.
 * @param {string} hash @returns {Route}
 */
export function parseRoute(hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = Object.fromEntries(new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)));
  if (path === '/board') return { name: 'board', tab: 'board', params, id: null };
  if (path === '/activity') return { name: 'activity', tab: 'activity', params, id: null };
  const task = /^\/task\/([1-9]\d{0,14})$/.exec(path);
  if (task) return { name: 'task', tab: 'board', params, id: Number(task[1]) };
  return { name: 'overview', tab: 'overview', params, id: null };
}

// ------------------------------------------------------------------------------------------------
// Views: views/*.js, and placeholders until board.js, activity.js and task.js replace them
// ------------------------------------------------------------------------------------------------

/** @param {string} title @returns {View} */
const placeholder = (title) => () => h('div', { class: 'page' }, h('h1', { class: 'page-title' }, title));

/** @type {View} The Board's column headers, with their counts. */
function boardPlaceholder({ view }) {
  return h('div', { class: 'page' },
    h('h1', { class: 'page-title' }, 'Board'),
    h('div', { class: 'columns' }, COLUMNS.map(([key, label]) => h('section', { class: 'column', 'data-testid': `column-${key}` },
      h('div', { class: 'column-head' },
        h('span', { class: `dot dot-${key}` }),
        h('h2', { class: 'column-name' }, label.toUpperCase()),
        h('span', { class: 'column-count', 'data-testid': 'column-count' }, view.counts?.[key] ?? 0))))));
}

/** @type {View} */
function taskPlaceholder({ task }) {
  if (task?.error) return h('div', { class: 'page' }, h('p', { class: 'page-note' }, task.error));
  if (!task?.data) return h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'Loading the task'));
  return h('div', { class: 'page' }, h('h1', { class: 'page-title' },
    h('span', { class: 'mono' }, `#${task.data.id}`), ' ', h('span', { class: 'bidi', dir: 'auto' }, task.data.title)));
}

/** @type {Record<RouteName, View>} */
const VIEWS = {
  overview,
  board: boardPlaceholder,
  activity: placeholder('Activity'),
  task: taskPlaceholder,
};

// ------------------------------------------------------------------------------------------------
// State and elements
// ------------------------------------------------------------------------------------------------

const state = {
  /** @type {any} /api/view, once loaded */
  view: null,
  /** the server's clock minus this browser's, at the last load */
  offset: 0,
  route: parseRoute(location.hash),
  /** @type {TaskLoad | null} */
  task: null,
  /** @type {'connecting' | 'live' | 'offline'} */
  conn: 'connecting',
  /** @type {{ project: string, count: number } | null} a dismissal made on this page (kept when storage fails) */
  dismissed: null,
  /** the bad-lines count the banner shows, 0 when hidden */
  bannerCount: 0,
};

/** @param {string} selector @returns {HTMLElement} */
const el = (selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const els = {
  project: el('[data-testid="project-name"]'),
  tabs: /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-tab]')]),
  search: /** @type {HTMLInputElement} */ (el('[data-testid="search"]')),
  live: el('[data-testid="live"]'),
  liveText: el('.live-text'),
  banner: el('#banner'),
  main: el('#app'),
};

const now = () => Date.now() + state.offset;

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

function renderHeader() {
  const { view, route, conn } = state;
  if (view) {
    els.project.textContent = view.project;
    els.project.title = view.project; // the full name when it is cut short
    document.title = `${view.project} · agentboard`;
  }
  for (const tab of els.tabs) {
    if (tab.dataset.tab === route.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  els.live.dataset.state = conn;
  els.liveText.textContent = conn !== 'live' ? conn : view ? `${plural(view.activeCount, 'agent')} active · live` : 'live';
}

/** The dismissed count stored for `project`, or null. @param {string} project */
function storedDismissal(project) {
  try {
    const v = localStorage.getItem(DISMISSED_KEY + project);
    return v == null ? null : Number(v);
  } catch {
    return null; // storage unavailable (blocked, private mode): only this page's dismissal counts
  }
}

/** Hides the banner for this count of bad lines; a different count shows it again. @param {string} project @param {number} count */
function dismiss(project, count) {
  state.dismissed = { project, count };
  try {
    localStorage.setItem(DISMISSED_KEY + project, String(count));
  } catch {
    // storage unavailable: remembered for this page only
  }
  renderBanner();
}

function renderBanner() {
  const n = state.view?.badLines ?? 0;
  const project = state.view?.project ?? '';
  const dismissed = (state.dismissed?.project === project && state.dismissed.count === n) || storedDismissal(project) === n;
  const count = n > 0 && !dismissed ? n : 0;
  if (count === state.bannerCount) return;
  state.bannerCount = count;
  if (count === 0) return void els.banner.replaceChildren();
  els.banner.replaceChildren(h('div', { class: 'banner', role: 'status', 'data-testid': 'banner-bad-lines' },
    h('span', { class: 'banner-text' }, `${plural(count, 'line')} of the board's log could not be read and ${count === 1 ? 'was' : 'were'} skipped.`),
    h('span', { class: 'banner-hint' }, h('code', null, 'agentboard repair'), ' lists them.'),
    h('button', { type: 'button', class: 'banner-dismiss', onclick: () => dismiss(project, count) }, 'Dismiss')));
}

function renderMain() {
  const { view, route } = state;
  if (!view) return void els.main.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'Loading the board')));
  try {
    const out = VIEWS[route.name]({ view, route, now: now(), task: route.name === 'task' ? state.task : null });
    els.main.replaceChildren(...[out].flat());
  } catch (err) {
    console.error(err);
    els.main.replaceChildren(h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'This view could not be shown. Reload the page to try again.')));
  }
}

function render() {
  renderHeader();
  renderBanner();
  renderMain();
}

// ------------------------------------------------------------------------------------------------
// Data
// ------------------------------------------------------------------------------------------------

/**
 * `fn` wrapped so that runs never overlap: a call during a run makes one more run after it.
 * @param {() => Promise<void>} fn @returns {() => Promise<void>}
 */
function serial(fn) {
  let running = false;
  let again = false;
  return async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await fn();
      } while (again);
    } finally {
      running = false;
    }
  };
}

/** GETs JSON; a failed answer throws with its status and the server's message. @param {string} path */
async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store', headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

const loadView = serial(async () => {
  try {
    const view = await getJson('/api/view');
    state.view = view;
    state.offset = Number.isFinite(view.now) ? view.now - Date.now() : 0;
  } catch {
    return; // offline, or a failed answer: keep what is shown
  }
  render();
});

const loadTask = serial(async () => {
  const { id } = state.route;
  if (state.route.name !== 'task' || id == null) return;
  /** @type {TaskLoad} */
  let next;
  try {
    next = { id, data: await getJson(`/api/task/${id}`), error: null };
  } catch (err) {
    if (/** @type {any} */ (err).status !== 404) return;
    next = { id, data: null, error: /** @type {Error} */ (err).message };
  }
  if (state.route.name !== 'task' || state.route.id !== id) return; // the page moved on meanwhile
  state.task = next;
  renderMain();
});

function refresh() {
  loadView();
  if (state.route.name === 'task') loadTask();
}

// ------------------------------------------------------------------------------------------------
// Live updates
// ------------------------------------------------------------------------------------------------

/** @param {'connecting' | 'live' | 'offline'} conn */
function setConn(conn) {
  state.conn = conn;
  renderHeader();
}

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    setConn('live');
    refresh();
  });
  events.addEventListener('change', refresh);
  events.addEventListener('error', () => {
    setConn('offline');
    // The browser retries by itself while the stream is CONNECTING; once CLOSED it has given up.
    if (events.readyState === EventSource.CLOSED) setTimeout(connect, RECONNECT_MS);
  });
}

// ------------------------------------------------------------------------------------------------
// Routing and search
// ------------------------------------------------------------------------------------------------

function onRoute() {
  const prev = state.route;
  state.route = parseRoute(location.hash);
  const { route } = state;
  if (route.name !== 'task') state.task = null;
  else if (state.task?.id !== route.id) {
    state.task = { id: /** @type {number} */ (route.id), data: null, error: null };
    loadTask();
  }
  if (document.activeElement !== els.search) els.search.value = route.name === 'board' ? route.params.q ?? '' : '';
  render();
  if (prev.name !== route.name || prev.id !== route.id) window.scrollTo(0, 0);
}

els.search.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const q = els.search.value.trim();
  location.hash = q ? `#/board?${new URLSearchParams({ q })}` : '#/board';
});

window.addEventListener('hashchange', onRoute);
onRoute();
loadView();
connect();
setInterval(refresh, REFRESH_MS);
setInterval(renderMain, TICK_MS);
