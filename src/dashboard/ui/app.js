import { h } from './dom.js';
import { plural } from './format.js';
import { activity } from './views/activity.js';
import { board } from './views/board.js';
import { overview } from './views/overview.js';
import { task } from './views/task.js';

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
 * - A load whose view differs from the last one only in `now` renders nothing.
 *
 * Live stream: only a visible tab holds one. The browser allows 6 connections per origin and every
 * open stream holds one (and every open_board opens a tab), so a hidden tab closes its stream and
 * opens it again when shown; the load on `open` catches it up.
 *
 * Rendering the main area (renderMain). With agents at work, live loads come every few seconds, so a
 * render must not get in the user's way:
 * - it waits while the user is in the middle of something in the main area: a <select> there is
 *   open (:open, where the browser has it), or was pressed or opened from the keyboard (Space, Enter,
 *   F4, the arrow keys, with or without Alt) and has not fired change or focusout yet; or a text
 *   selection lies there. It runs when that ends. A route change renders at once.
 * - it keeps the focus on the element with the same `data-key`, and the scroll position of every
 *   element with a `data-scroll-key`.
 *
 * The clock: the server's `now` at the last load plus the time since then on this browser's clock,
 * so relative times agree with the server even when it runs on a fixed clock (screenshots).
 *
 * @typedef {'overview' | 'board' | 'activity' | 'task'} RouteName
 * @typedef {{ name: RouteName, tab: 'overview' | 'board' | 'activity', params: Record<string, string>, id: number | null }} Route
 *   params: the hash's query as strings (#/board?epic=3 gives { epic: '3' }); id: the task view's task
 * @typedef {{ id: number, data: any, error: string | null }} TaskLoad
 *   data: /api/task/<id> once loaded, else null; error: the server's message for a missing task
 * @typedef {{ view: any, route: Route, now: number, task: TaskLoad | null, rerender: () => void }} ViewContext
 *   view: /api/view; task: on the task route only; rerender: builds the current view again, as a
 *   load does (it waits while the user is interacting), for state a view keeps itself, such as the
 *   answer of its own request or a list it opened
 * @typedef {(ctx: ViewContext) => Node | Node[]} View
 *   A view returns the main area's content. It is called again on every load and every 30 s, so:
 *   - it keeps no state in the DOM that a render would lose (a module-level map, if it must);
 *   - its focusable elements have a stable `data-key` (such as "copy-q-m12" or "filter-epic"), and
 *     its inner scrollers a `data-scroll-key`;
 *   - its times are relative to the context's `now`, never Date.now().
 *   Board text goes in as text (dom.js h()).
 */

const REFRESH_MS = 60_000;
const TICK_MS = 30_000;
/** Wait before opening a new event stream when the browser gave up on the last one. */
const RECONNECT_MS = 5_000;
/** localStorage key prefix of the dismissed malformed-lines count, per project. */
const DISMISSED_KEY = 'planrelay.badLinesDismissed:';

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
// Views: views/*.js
// ------------------------------------------------------------------------------------------------

/** @type {Record<RouteName, View>} */
const VIEWS = { overview, board, activity, task };

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
  /** the last view loaded, as JSON without `now`: an equal load renders nothing */
  viewKey: '',
  /** a render of the main area waits for the user (see interacting) */
  pending: false,
  /** @type {HTMLSelectElement | null} a <select> in the main area pressed, and not yet changed or left */
  pressedSelect: null,
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
    document.title = `${view.project} · planrelay`;
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
    h('span', { class: 'banner-hint' }, h('code', null, 'planrelay repair'), ' lists them.'),
    h('button', { type: 'button', class: 'banner-dismiss', onclick: () => dismiss(project, count) }, 'Dismiss')));
}

/** Is the user in the middle of something in the main area that a render would undo? */
function interacting() {
  if (state.pressedSelect?.isConnected) return true;
  try {
    if (els.main.querySelector('select:open')) return true;
  } catch {
    // a browser without :open: the pressed or keyed select above is the only sign
  }
  const selection = window.getSelection();
  return selection != null && !selection.isCollapsed
    && (els.main.contains(selection.anchorNode) || els.main.contains(selection.focusNode));
}

/**
 * Puts `nodes` in the main area. The focus goes back to the element with the same data-key, and
 * every [data-scroll-key] element keeps its scroll position.
 * @param {Node[]} nodes
 */
function replaceMain(nodes) {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && els.main.contains(active) ? active.dataset.key : undefined;
  /** @type {[string, number][]} */
  const scrolled = [...els.main.querySelectorAll('[data-scroll-key]')]
    .map((el) => [/** @type {HTMLElement} */ (el).dataset.scrollKey ?? '', el.scrollTop]);
  els.main.replaceChildren(...nodes);
  for (const [scrollKey, top] of scrolled) {
    const el = els.main.querySelector(`[data-scroll-key="${CSS.escape(scrollKey)}"]`);
    if (el) el.scrollTop = top;
  }
  if (key == null) return;
  const same = /** @type {HTMLElement | null} */ (els.main.querySelector(`[data-key="${CSS.escape(key)}"]`));
  same?.focus({ preventScroll: true });
}

/** @param {boolean} [force] render even while the user is interacting (a route change) */
function renderMain(force = false) {
  if (!force && interacting()) {
    state.pending = true;
    return;
  }
  state.pending = false;
  const { view, route } = state;
  if (!view) return void replaceMain([h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'Loading the board'))]);
  try {
    const out = VIEWS[route.name]({ view, route, now: now(), task: route.name === 'task' ? state.task : null, rerender: () => renderMain() });
    replaceMain([out].flat());
  } catch (err) {
    console.error(err);
    replaceMain([h('div', { class: 'page' }, h('p', { class: 'page-note' }, 'This view could not be shown. Reload the page to try again.'))]);
  }
}

/** Runs the render that waited for the user, once they are done. */
function flush() {
  if (state.pending && !interacting()) renderMain();
}

/** @param {boolean} [force] see renderMain */
function render(force = false) {
  renderHeader();
  renderBanner();
  renderMain(force);
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
  let view;
  try {
    view = await getJson('/api/view');
  } catch {
    return; // offline, or a failed answer: keep what is shown
  }
  state.view = view;
  state.offset = Number.isFinite(view.now) ? view.now - Date.now() : 0;
  const key = JSON.stringify({ ...view, now: 0 });
  if (key === state.viewKey) return; // nothing new: the 30 s render keeps the times fresh
  state.viewKey = key;
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

/** @type {EventSource | null} this tab's event stream; null while the tab is hidden */
let stream = null;

function connect() {
  if (stream || document.hidden) return;
  const events = new EventSource('/api/events');
  stream = events;
  events.addEventListener('open', () => {
    setConn('live');
    refresh();
  });
  events.addEventListener('change', refresh);
  events.addEventListener('error', () => {
    setConn('offline');
    // The browser retries by itself while the stream is CONNECTING; once CLOSED it has given up.
    if (events.readyState === EventSource.CLOSED && stream === events) {
      stream = null;
      setTimeout(connect, RECONNECT_MS);
    }
  });
}

// A hidden tab gives its stream back, and takes one again when shown (see the top of this file).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return connect();
  stream?.close();
  stream = null;
  setConn('connecting');
});

// A render waits while a <select> in the main area is open, or text there is selected (renderMain).
els.main.addEventListener('pointerdown', (e) => {
  const select = e.target instanceof Element ? e.target.closest('select') : null;
  if (select) state.pressedSelect = select;
});
// Keys that open a select's list on some system (Enter on Windows and Linux, the arrows on macOS).
// Where an arrow changes the value instead, it fires change, which ends the wait at once.
const OPENS_SELECT = new Set([' ', 'Enter', 'F4', 'ArrowDown', 'ArrowUp']);
els.main.addEventListener('keydown', (e) => {
  if (OPENS_SELECT.has(e.key) && e.target instanceof HTMLSelectElement) state.pressedSelect = e.target;
});
for (const type of ['change', 'focusout']) {
  els.main.addEventListener(type, (e) => {
    if (e.target !== state.pressedSelect) return;
    state.pressedSelect = null;
    flush();
  });
}
document.addEventListener('selectionchange', flush);

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
  render(true);
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
setInterval(() => renderMain(), TICK_MS);
