import { getAgent } from './agents.js';
import { blockers } from './derive.js';
import { systemMessage } from './maintenance.js';
import { FILES_LIMIT } from './reduce.js';
import { redact } from './redact.js';

/**
 * @typedef {{
 *   state: import('./reduce.js').BoardState,
 *   reg: import('./store.js').Registry,
 *   cfg: import('./config.js').Config,
 *   agentId: string,
 *   now: number
 * }} Ctx
 */

/** An error whose message is meant for the agent (§16). */
export class BoardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BoardError';
  }
}

/** @returns {never} */
function fail(message) {
  throw new BoardError(message);
}

const TITLE_MAX = 200;
const TEXT_MAX = 20_000;
const LABEL_MAX = 40;
const LABELS_MAX = 10;
const LINK_TITLE_MAX = 200;
const LINK_TARGET_MAX = 2000;
const LINKS_MAX = 20;
const DEPENDS_MAX = 50;
/** Lists longer than this are refused before any entry is looked at, so a huge input costs nothing. */
const RAW_LIST_MAX = 1000;
/** Error messages quote at most this much of a bad value. */
const ECHO_MAX = 40;
/** The marker redact() puts in place of a secret. */
const REDACTED = '[REDACTED]';

const TOO_MANY_DEPENDS = `A task can depend on at most ${DEPENDS_MAX} tasks; group work under an epic instead.`;
const TOO_MANY_LABELS = `A task can have at most ${LABELS_MAX} labels.`;
const TOO_MANY_LINKS = `A task can have at most ${LINKS_MAX} links; keep the most useful ones.`;
const EPIC_NO_DEPENDS = 'Epics cannot have dependencies; set dependsOn on the tasks inside it.';
const LINK_HELP = 'use an http(s) URL or a path inside the repository, such as docs/plan.md';
/** What update_task can change, in the order the "Nothing to update" message lists it. */
const UPDATABLE = ['title', 'description', 'parent', 'labels', 'links', 'rank', 'addDependsOn', 'removeDependsOn', 'approved'];
/** The fields each tool takes (§8); anything else is refused, so a typo is never silently ignored (§14). */
const FIELDS = {
  create: ['title', 'description', 'kind', 'parent', 'dependsOn', 'labels', 'requestedByHuman'],
  update: ['id', ...UPDATABLE],
  claim: ['id', 'takeOver'],
  post: ['taskId', 'text', 'kind', 'to', 'replyTo', 'relayedFromHuman'],
  complete: ['id', 'summary'],
  release: ['id', 'note'],
};

// ---------------------------------------------------------------------------------------------
// Input normalization (§14). Every value an agent sends goes through these; the MCP layer passes
// tool arguments straight through, so this is the only validator. queries.js checks list filters
// with the exported ones, so both answer a bad value the same way.
// ---------------------------------------------------------------------------------------------

/**
 * Removed from every text field, one-line or multi-line (§14): invisible characters that can hide
 * instructions from the human or split a secret so redaction misses it. Unicode tag characters
 * (U+E0000-E007F, "ASCII smuggling"), variation selectors 17-256 (U+E0100-E01EF, which can carry
 * hidden bytes; U+FE0F, which emoji need, stays), word joiner and invisible operators (U+2060-2064),
 * soft hyphen, U+180E, U+034F, zero-width space and U+FEFF. The u flag is safe: texts are made well-formed first.
 */
const HIDDEN = /[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\u2060-\u2064\u00ad\u180e\u034f\u200b\ufeff]/gu;
/**
 * One-line fields also lose C0 and C1 controls (whitespace is collapsed instead), bidi controls and
 * marks (U+202A-202E, U+2066-2069, U+200E, U+200F, U+061C), ZWNJ and ZWJ.
 */
const ONE_LINE_DROP = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200c-\u200f\u202a-\u202e\u2066-\u2069\u061c]/g;
/** Multi-line fields keep newlines and tabs; every other control character goes. Bidi marks, ZWNJ and ZWJ stay. */
const MULTI_LINE_DROP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Lone surrogates become U+FFFD; hidden characters go. */
const visible = (s) => s.toWellFormed().replace(HIDDEN, '');
/** A one-line text without hidden, control, bidi or zero-width characters; whitespace is kept (see collapse). */
const dropInvisible = (s) => visible(s).replace(ONE_LINE_DROP, '');
/** A multi-line text with LF line ends and no hidden or control characters but newlines and tabs. */
const multiLine = (s) => visible(s).replace(/\r\n?/g, '\n').replace(MULTI_LINE_DROP, '');
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** An own field's value; null and undefined both mean "not provided" (§14). */
const given = (obj, key) => (Object.hasOwn(obj, key) && obj[key] != null ? obj[key] : undefined);

/**
 * The tool input as an object of fields; missing input counts as no fields. A field that is not in
 * `allowed` is an error that lists the allowed ones (§14).
 * @param {unknown} input @param {string[]} allowed
 */
export function fieldsOf(input, allowed) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) fail('The input must be an object of named fields.');
  for (const key of Object.keys(input)) {
    if (allowed.includes(key)) continue;
    const near = allowed.find((a) => a.toLowerCase() === key.toLowerCase());
    fail(`Unknown field ${echo(key)}${near ? ` (did you mean ${near}?)` : ''}; allowed: ${allowed.join(', ')}.`);
  }
  return /** @type {Record<string, any>} */ (input);
}

/** A short, one-line, redacted rendering of a value for an error message: at most ECHO_MAX characters of it. */
function echo(value) {
  if (typeof value === 'string') {
    const s = redact(collapse(dropInvisible(value.slice(0, 4 * ECHO_MAX))));
    return JSON.stringify(s.length > ECHO_MAX ? `${s.slice(0, ECHO_MAX)}…` : s);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, ECHO_MAX);
  if (Array.isArray(value)) return 'a list';
  if (value === null) return 'null';
  return typeof value === 'object' ? 'an object' : typeof value;
}

/** " (got …)" for an error message about a bad value. */
export const got = (value) => ` (got ${echo(value)})`;

/**
 * Cuts a stored text down to `max` characters: never inside a surrogate pair or a [REDACTED] marker.
 * Needed because a marker can be longer than the secret it replaced.
 */
function capAt(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const open = cut.lastIndexOf('[');
  if (open >= 0 && cut.length - open < REDACTED.length && REDACTED.startsWith(cut.slice(open))) cut = cut.slice(0, open);
  return cut.trimEnd();
}

/**
 * Redacts a text and caps it at `max` so that what is stored is stable: redact(result) === result.
 * A cut can leave a token-shaped end, and lower-casing can make one, so this repeats until redaction
 * changes nothing; every round replaces secret text with the marker, so it ends.
 */
function settle(s, max) {
  let out = capAt(redact(s), max);
  for (let next = redact(out); next !== out; next = redact(out)) out = capAt(next, max);
  return out;
}

/**
 * A text value: must be a string when given; normalized; refused when empty and required or longer
 * than `max` after normalization; then redacted and capped at `max` (settle).
 * One-line texts are redacted before whitespace is collapsed (a line end tells a `KEY: value` apart
 * from prose) and again after (collapsing can join "Bearer" and its token).
 * @returns {string | undefined} undefined when not given (or empty) and not required
 */
function readText(value, field, { max, oneLine, required }) {
  if (value == null) return required ? fail(`${field} is required.`) : undefined;
  if (typeof value !== 'string') fail(`${field} must be text${got(value)}.`);
  const kept = oneLine ? dropInvisible(value) : multiLine(value);
  const plain = oneLine ? collapse(kept) : kept.trim();
  if (!plain) return required ? fail(`${field} is required.`) : '';
  if (plain.length > max) fail(`${field} is too long (max ${max} characters).`);
  return settle(oneLine ? collapse(redact(kept)) : plain, max);
}

/** A multi-line text (description, message, summary, note), normalized and redacted; '' when absent and optional. */
function cleanText(value, field, { required = true, max = TEXT_MAX } = {}) {
  return readText(value, field, { max, required, oneLine: false }) ?? '';
}

/** A one-line text (title, link title), normalized and redacted. */
function cleanLine(value, field, { required = true, max = TITLE_MAX } = {}) {
  return readText(value, field, { max, required, oneLine: true }) ?? '';
}

/** true or false; undefined when not given. */
function flag(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(`${field} must be true or false${got(value)}.`);
  return value;
}

/** A task number: a whole number of 1 or more. Checked before any lookup. */
export function taskNumber(value, field) {
  if (value == null) fail(`${field} is required: a task number such as 12.`);
  if (!Number.isSafeInteger(value) || value < 1) {
    const hint = typeof value === 'string' && /^\s*#?\d+\s*$/.test(value) ? ', written as a number without quotes or "#"' : '';
    fail(`${field} must be a task number such as 12${hint}${got(value)}.`);
  }
  return value;
}

/** A list of task numbers, each once. `tooMany` is the error for a list longer than RAW_LIST_MAX. */
function taskNumbers(value, field, tooMany) {
  const help = `${field} must be a list of task numbers such as [3, 4]`;
  if (!Array.isArray(value)) fail(`${help}${got(value)}.`);
  if (value.length > RAW_LIST_MAX) fail(tooMany);
  const bad = value.findIndex((v) => !Number.isSafeInteger(v) || v < 1);
  if (bad >= 0) fail(`${help}${got(value[bad])}.`);
  return [...new Set(value)];
}

/**
 * Labels (§14): one-line, NFC, redacted, then lower-cased (the patterns are case-sensitive; the
 * marker keeps its case) and redacted again, since lower case can make a token shape ("GHP_…"),
 * so every stored label is stable under redact. Each once; empty labels are dropped. Anything but
 * text is an error.
 */
function cleanLabels(value) {
  const help = 'labels must be a list of text, such as ["bug"]';
  if (!Array.isArray(value)) fail(`${help}${got(value)}.`);
  if (value.length > RAW_LIST_MAX) fail(TOO_MANY_LABELS);
  const out = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') fail(`${help}${got(raw)}.`);
    const kept = dropInvisible(raw).normalize('NFC');
    const plain = collapse(kept);
    if (!plain) continue;
    if (plain.length > LABEL_MAX) fail(`Labels can be up to ${LABEL_MAX} characters long${got(plain)}.`);
    const redacted = redact(collapse(redact(kept)));
    const lower = redacted.split(REDACTED).map((part) => part.toLowerCase()).join(REDACTED).normalize('NFC');
    out.add(settle(lower, LABEL_MAX));
    if (out.size > LABELS_MAX) fail(TOO_MANY_LABELS);
  }
  return [...out];
}

const SCHEME = /^([a-z][a-z\d+.-]*):/i;

/**
 * A link target (§4): an http(s) URL, or a path inside the repository (relative, no drive letter,
 * no leading / or //, no .. that climbs out). Any other scheme (javascript:, data:, file:) is refused.
 * Checked as stored, after redaction and capping: a redacted run can swallow a "/" and so change
 * how far a path climbs.
 */
function linkTarget(value) {
  const target = cleanLine(value, 'link target', { max: LINK_TARGET_MAX });
  const scheme = SCHEME.exec(target)?.[1];
  // for the path checks: backslashes and percent-encoded dots and slashes count as what they encode
  const slashed = target.replaceAll('\\', '/').replace(/%2f|%5c/gi, '/').replace(/%2e/gi, '.');
  if (scheme?.length === 1) fail(`link target ${echo(target)} starts with a drive letter; ${LINK_HELP}.`);
  if (scheme) {
    const lower = scheme.toLowerCase();
    if (lower !== 'http' && lower !== 'https') fail(`link target: "${lower.slice(0, ECHO_MAX)}:" links are not allowed; ${LINK_HELP}.`);
    let url;
    try {
      url = new URL(target);
    } catch {
      fail(`link target ${echo(target)} is not a valid URL; ${LINK_HELP}.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`link target: only http(s) URLs are allowed; ${LINK_HELP}.`);
    return target;
  }
  if (slashed.startsWith('/')) fail(`link target ${echo(target)} is not a path inside the repository; ${LINK_HELP}.`);
  let depth = 0;
  for (const s of slashed.split('/')) {
    if (s === '..') depth -= 1;
    else if (s !== '' && s !== '.') depth += 1;
    if (depth < 0) fail(`link target ${echo(target)} points outside the repository; ${LINK_HELP}.`);
  }
  return target;
}

/** Links: { title, target } objects, at most LINKS_MAX once exact duplicates are removed. */
function cleanLinks(value) {
  const help = 'links must be a list of { title, target }, such as [{ "title": "Plan", "target": "docs/plan.md" }]';
  if (!Array.isArray(value)) fail(`${help}${got(value)}.`);
  if (value.length > RAW_LIST_MAX) fail(TOO_MANY_LINKS);
  const out = [];
  const seen = new Set();
  for (const link of value) {
    if (link === null || typeof link !== 'object' || Array.isArray(link)) fail(`${help}${got(link)}.`);
    const title = cleanLine(given(link, 'title'), 'link title', { max: LINK_TITLE_MAX });
    const target = linkTarget(given(link, 'target'));
    const key = JSON.stringify([title, target]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, target });
    if (out.length > LINKS_MAX) fail(TOO_MANY_LINKS);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Board rules
// ---------------------------------------------------------------------------------------------

/** The task with this number; the number's type is checked first (§16). */
function getTask(ctx, value, field = 'id') {
  const id = taskNumber(value, field);
  return Object.hasOwn(ctx.state.tasks, id) ? ctx.state.tasks[id] : fail(`#${id} does not exist. list_tasks shows the task numbers.`);
}

/**
 * The display name of the agent holding a task: the registry's current name, else the name stored
 * with the claim; null when neither knows it (the registry forgets ended agents after 7 days).
 * @returns {string | null}
 */
function holderName(ctx, t) {
  return getAgent(ctx.reg, t.assignee)?.name ?? t.assigneeName ?? null;
}

function checkParent(ctx, value, kind, selfId) {
  const p = getTask(ctx, value, 'parent');
  if (p.id === selfId) fail('A task cannot be its own parent.');
  if (p.kind !== 'epic') fail(`#${p.id} is not an epic; only epics contain tasks — use dependsOn for order.`);
  if (kind === 'epic') {
    if (p.parent != null) fail(`#${p.id} is a sub-epic, and epics nest one level only; choose a top-level epic as the parent.`);
    if (selfId != null && Object.values(ctx.state.tasks).some((t) => t.kind === 'epic' && t.parent === selfId)) {
      fail(`#${selfId} has sub-epics, so it cannot become a sub-epic; move its sub-epics out first.`);
    }
  }
  return p.id;
}

function checkDependency(ctx, selfId, depId) {
  if (depId === selfId) fail('A task cannot depend on itself.');
  const dep = getTask(ctx, depId, 'dependsOn');
  if (dep.kind === 'epic') fail(`#${depId} is an epic; depend on the tasks inside it instead.`);
}

/**
 * A dependency path that leads from one of `starts` back to `selfId`, as [selfId, start, …, selfId],
 * or null. One depth-first walk from all the new dependencies together, so every task and every
 * dependency is visited at most once, however many dependencies are added.
 */
function cycleThrough(tasks, selfId, starts) {
  /** @type {Map<number, number | null>} a visited task → the task whose dependency led to it */
  const from = new Map();
  const stack = [];
  for (const s of starts) {
    from.set(s, null);
    stack.push(s);
  }
  while (stack.length) {
    const id = /** @type {number} */ (stack.pop());
    const t = Object.hasOwn(tasks, id) ? tasks[id] : undefined;
    for (const d of t?.dependsOn ?? []) {
      if (d === selfId) {
        const chain = [];
        for (let x = /** @type {number | null | undefined} */ (id); x != null; x = from.get(x)) chain.push(x);
        return [selfId, ...chain.reverse(), selfId];
      }
      if (!from.has(d)) {
        from.set(d, id);
        stack.push(d);
      }
    }
  }
  return null;
}

/** "#2 → #1 → #2", with the middle of a long path left out. */
function showPath(path) {
  const ids = path.map((id) => `#${id}`);
  return (ids.length > 8 ? [...ids.slice(0, 4), '…', ...ids.slice(-3)] : ids).join(' → ');
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameLinks = (a, b) => a.length === b.length && a.every((l, i) => l.title === b[i].title && l.target === b[i].target);
const sameSet = (a, b) => {
  const set = new Set(b);
  return a.length === set.size && a.every((v) => set.has(v));
};

/** Task ids mentioned as #N in a text, excluding the task itself and unknown ids. */
export function mentionsIn(content, state, selfId) {
  const ids = new Set();
  for (const m of content.matchAll(/(^|[^\w&/])#(\d+)\b/g)) {
    const id = Number(m[2]);
    if (id !== selfId && Number.isSafeInteger(id) && Object.hasOwn(state.tasks, id)) ids.add(id);
  }
  return [...ids];
}

/** The task this agent currently holds, if any. */
export function claimedBy(state, agentId) {
  return Object.values(state.tasks).find((t) => t.assignee === agentId && !t.done) ?? null;
}

/** The only fields messageEvent's `extra` may add to a message; anything else is dropped. */
const MESSAGE_EXTRA = ['to', 'replyTo', 'relayedFromHuman', 'mentions', 'about', 'closesQuestions'];

/**
 * A message event by the acting agent, with its display name (§4). Callers must pass `content`
 * already normalized and redacted (cleanText does both); it is stored as given. `extra` may set only
 * the MESSAGE_EXTRA fields (to, replyTo, relayedFromHuman, mentions, about, closesQuestions); the task,
 * author, name, kind and text always come from the arguments.
 * @param {Ctx} ctx @param {number} taskId @param {string} kind @param {string} content @param {Record<string, any>} [extra]
 */
export function messageEvent(ctx, taskId, kind, content, extra = {}) {
  const added = Object.fromEntries(MESSAGE_EXTRA.filter((k) => Object.hasOwn(extra, k) && extra[k] !== undefined).map((k) => [k, extra[k]]));
  return {
    type: 'message.posted',
    actor: ctx.agentId,
    data: {
      message: {
        to: null, replyTo: null, relayedFromHuman: false, mentions: mentionsIn(content, ctx.state, taskId), ...added,
        taskId, author: ctx.agentId, authorName: getAgent(ctx.reg, ctx.agentId)?.name ?? null, kind, text: content,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/**
 * create_task (§8). A task the human asked for is approved and records the agent that relayed it
 * (requestedVia); an agent's suggestion waits in Backlog unless the config says
 * agentTasksNeedApproval: false (anything else, including a missing config, needs approval).
 * @param {Ctx} ctx
 */
export function createTask(ctx, input) {
  requireActor(ctx);
  const f = fieldsOf(input, FIELDS.create);
  const kind = given(f, 'kind') ?? 'task';
  if (kind !== 'task' && kind !== 'epic') fail(`kind must be "task" or "epic"${got(kind)}.`);
  const title = cleanLine(given(f, 'title'), 'title', { max: TITLE_MAX });
  const description = cleanText(given(f, 'description'), 'description', { required: false });
  const parentIn = given(f, 'parent');
  const parent = parentIn === undefined ? null : checkParent(ctx, parentIn, kind, null);
  const dependsIn = given(f, 'dependsOn');
  const dependsOn = dependsIn === undefined ? [] : taskNumbers(dependsIn, 'dependsOn', TOO_MANY_DEPENDS);
  if (kind === 'epic' && dependsOn.length) fail(EPIC_NO_DEPENDS);
  if (dependsOn.length > DEPENDS_MAX) fail(TOO_MANY_DEPENDS);
  for (const d of dependsOn) checkDependency(ctx, null, d); // a new task has no dependents, so no cycle is possible
  const labelsIn = given(f, 'labels');
  const labels = labelsIn === undefined ? [] : cleanLabels(labelsIn);
  const byHuman = flag(given(f, 'requestedByHuman'), 'requestedByHuman') ?? false;
  const id = ctx.state.nextId;
  const approved = kind === 'epic' || byHuman || ctx.cfg?.agentTasksNeedApproval === false;
  const name = getAgent(ctx.reg, ctx.agentId)?.name ?? null;
  const task = {
    id, kind, title, description, parent, labels, dependsOn,
    origin: byHuman ? 'human' : 'agent',
    createdBy: byHuman ? 'human' : ctx.agentId,
    ...(byHuman ? { requestedVia: ctx.agentId, requestedViaName: name } : { createdByName: name }),
    approved, rank: id,
  };
  return { events: [{ type: 'task.created', actor: ctx.agentId, data: { task } }], result: { id, approved } };
}

/**
 * update_task (§8). Only fields that change are written; when nothing changes the result is
 * { id, unchanged: true } and no event is emitted. null means "not provided", except for parent,
 * where it detaches the task from its epic.
 * @param {Ctx} ctx
 */
export function updateTask(ctx, input) {
  requireActor(ctx);
  const f = fieldsOf(input, FIELDS.update);
  const t = getTask(ctx, given(f, 'id'));
  const provided = (k) => (k === 'parent' ? Object.hasOwn(f, k) && f[k] !== undefined : given(f, k) !== undefined);
  if (!UPDATABLE.some(provided)) fail(`Nothing to update. Give #${t.id} at least one of: ${UPDATABLE.join(', ')}.`);
  /** @type {Record<string, any>} */
  const changes = {};
  const title = given(f, 'title');
  if (title !== undefined) {
    const v = cleanLine(title, 'title', { max: TITLE_MAX });
    if (v !== t.title) changes.title = v;
  }
  const description = given(f, 'description');
  if (description !== undefined) {
    const v = cleanText(description, 'description', { required: false });
    if (v !== t.description) changes.description = v;
  }
  if (provided('parent')) {
    const v = f.parent === null ? null : checkParent(ctx, f.parent, t.kind, t.id);
    if (v !== t.parent) changes.parent = v;
  }
  const labels = given(f, 'labels');
  if (labels !== undefined) {
    const v = cleanLabels(labels);
    if (!sameList(v, t.labels)) changes.labels = v;
  }
  const links = given(f, 'links');
  if (links !== undefined) {
    const v = cleanLinks(links);
    if (!sameLinks(v, t.links)) changes.links = v;
  }
  const rank = given(f, 'rank');
  if (rank !== undefined) {
    if (typeof rank !== 'number' || !Number.isFinite(rank)) fail(`rank must be a number${got(rank)}.`);
    if (rank !== t.rank) changes.rank = rank;
  }
  const addIn = given(f, 'addDependsOn');
  const removeIn = given(f, 'removeDependsOn');
  if (addIn !== undefined || removeIn !== undefined) {
    const remove = removeIn === undefined ? [] : taskNumbers(removeIn, 'removeDependsOn', TOO_MANY_DEPENDS);
    const add = addIn === undefined ? [] : taskNumbers(addIn, 'addDependsOn', TOO_MANY_DEPENDS);
    if (t.kind === 'epic' && (add.length || remove.length)) fail(EPIC_NO_DEPENDS);
    const deps = new Set(t.dependsOn);
    for (const d of remove) deps.delete(d);
    const added = add.filter((d) => !deps.has(d));
    if (added.length && deps.size + added.length > DEPENDS_MAX) fail(TOO_MANY_DEPENDS);
    for (const d of added) checkDependency(ctx, t.id, d);
    const cycle = added.length ? cycleThrough(ctx.state.tasks, t.id, added) : null;
    if (cycle) fail(`#${t.id} cannot depend on #${cycle[1]}: that would close a dependency cycle (${showPath(cycle)}).`);
    for (const d of added) deps.add(d);
    if (!sameSet([...deps], t.dependsOn)) changes.dependsOn = [...deps];
  }
  const events = [];
  if (Object.keys(changes).length) events.push({ type: 'task.updated', actor: ctx.agentId, data: { id: t.id, changes } });
  const approved = flag(given(f, 'approved'), 'approved');
  if (approved !== undefined && approved !== t.approved) {
    if (t.kind === 'epic') fail('Epics are always approved; approve the tasks inside it.');
    if (t.done) fail(`#${t.id} is done; its approval no longer changes.`);
    if (!approved && t.assignee) {
      if (t.assignee === ctx.agentId) fail(`You hold #${t.id}; release it before moving it back to Backlog.`);
      if (liveOwner(ctx, t)) fail(`#${t.id} is claimed by ${holderName(ctx, t)}; ask them to release it first.`);
      // the holder's session has ended (or the registry no longer knows it): nobody can be asked
      fail(`#${t.id} is ${endedHolder(ctx, t)}; it is released automatically after ${ctx.cfg.claimTimeoutHours} h without activity, `
        + 'or the human can ask you to take it over.');
    }
    events.push({ type: 'task.approved', actor: ctx.agentId, data: { id: t.id, approved } });
  }
  return { events, result: events.length ? { id: t.id } : { id: t.id, unchanged: true } };
}

// ---------------------------------------------------------------------------------------------
// Working on a task: claim, messages, completion, release (§8), and mirroring from the hooks (§9)
// ---------------------------------------------------------------------------------------------

/** What post_message can post; handoffs, summaries and system notes are written by the operations. */
const MESSAGE_KINDS = ['comment', 'question', 'answer'];
/** Checklist items kept per task. */
const CHECKLIST_MAX = 50;
/** A checklist item's text is cut to this length before any other work: the hook runs under the board lock. */
const ITEM_RAW_MAX = 1000;
/** A checklist item's text as stored, after redaction. */
const ITEM_MAX = 200;
/** A touched file's path as stored. */
const PATH_MAX = 300;

/** A system note on a task; its author's display name is stored like any message's (§4). */
const systemNote = (taskId, text, extra = {}) => systemMessage(taskId, text, { authorName: 'system', ...extra });

/**
 * The acting agent (§10): operations act only for a registered agent whose session has not ended.
 * The MCP server registers its agent before every call, so this fails only in a race with housekeeping.
 * @param {Ctx} ctx @returns {import('./agents.js').Agent}
 */
function requireActor(ctx) {
  const a = getAgent(ctx.reg, ctx.agentId);
  return a && a.endedAt == null ? a : fail('Your session is not registered on the board yet; try again.');
}

/** The same check for the hooks' mirroring, which never throws: an unregistered or ended agent mirrors nothing. */
function liveActor(ctx) {
  const a = getAgent(ctx.reg, ctx.agentId);
  return !!a && a.endedAt == null;
}

/**
 * True when another agent holds the task and is registered with a session that has not ended
 * (§10): only that agent may complete or release it, and nobody may take it over. An idle holder
 * still holds its task. A dead host process or claimTimeoutHours without activity count only once
 * housekeeping has ended that agent, which transact's `before` does in the same write, before the
 * operation runs.
 */
function liveOwner(ctx, t) {
  if (!t.assignee || t.assignee === ctx.agentId) return false;
  const holder = getAgent(ctx.reg, t.assignee);
  return !!holder && holder.endedAt == null;
}

/** "held by Jade, whose session has ended", or "held by a session that has ended" when no name is known. */
function endedHolder(ctx, t) {
  const name = holderName(ctx, t);
  return name ? `held by ${name}, whose session has ended` : 'held by a session that has ended';
}

/** The folder of a task's claim, one line, or null. */
function claimFolder(t) {
  const folder = t.claim?.folder;
  return typeof folder === 'string' ? collapse(dropInvisible(folder)) || null : null;
}

/**
 * claim_task (§8, §10). Claiming the task the agent already holds changes nothing. A task held by
 * a live agent is refused. A task held by a session that has ended (or that the registry no longer
 * knows) is taken over only with takeOver: true, which the skill passes only when the human asked:
 * a note naming the former holder and its folder is addressed to it (it is pinged if it comes back),
 * and the result says whose work was taken over. takeOver on a task nobody holds is a normal claim.
 * Open questions do not prevent a claim; open dependencies do.
 * @param {Ctx} ctx
 */
export function claimTask(ctx, input) {
  const me = requireActor(ctx);
  const f = fieldsOf(input, FIELDS.claim);
  const t = getTask(ctx, given(f, 'id'));
  const takeOver = flag(given(f, 'takeOver'), 'takeOver') ?? false;
  if (t.kind === 'epic') fail(`#${t.id} is an epic; claim one of its tasks.`);
  if (t.done) fail(`#${t.id} is already done; pick a Ready task instead.`);
  if (t.assignee && t.assignee === ctx.agentId) return { events: [], result: { id: t.id } };
  const held = claimedBy(ctx.state, ctx.agentId);
  if (held) fail(`You already hold #${held.id} "${held.title}". Complete or release it first.`);
  if (liveOwner(ctx, t)) fail(`#${t.id} is claimed by ${holderName(ctx, t)}. Ask them on the board or pick another task.`);
  const former = t.assignee ? { id: t.assignee, name: holderName(ctx, t), folder: claimFolder(t) } : null;
  if (former && !takeOver) {
    const about = [former.name, former.folder && `folder ${former.folder}`].filter(Boolean).join(', ');
    fail(`#${t.id} is held by a session that has ended${about ? ` (${about})` : ''}; pass takeOver: true only if the human asked you to continue it.`);
  }
  if (!t.approved) fail(`#${t.id} is in Backlog waiting for the human's approval. Approve it first only if the human asked for it.`);
  const waits = blockers(t, ctx.state.tasks).filter((b) => b.type === 'dependency').map((b) => `#${b.id}`);
  if (waits.length) fail(`#${t.id} waits on ${waits.join(', ')}. Pick a Ready task instead.`);
  const events = [];
  if (former) {
    // a new session can carry the gone holder's name (§4 Names, continuity)
    const from = former.name === null
      ? 'a session that had ended'
      : `${former.name === me.name ? `the earlier ${former.name}` : former.name}, whose session had ended`;
    const where = former.folder ? ` (folder ${former.folder})` : '';
    events.push(systemNote(t.id, `${me.name} took over from ${from}${where}.`, { to: former.id }));
  }
  events.push({ type: 'task.claimed', actor: ctx.agentId, data: { id: t.id, agent: ctx.agentId, agentName: me.name, folder: me.folder ?? null } });
  const result = former
    ? { id: t.id, takenOverFrom: former.id, takenOverFromName: former.name, formerFolder: former.folder }
    : { id: t.id };
  return { events, result };
}

/**
 * Who a question is for (§4): "human" or "any" (in any case), or a live agent other than the asker,
 * by id or by name (in any case). An agent whose session has ended, and the asker itself, are
 * refused with guidance. Agents are looked up by own keys only, so "toString" or "__proto__" never
 * match; live agents never share a name, so a name matches at most one live agent.
 */
function resolveRecipient(ctx, value) {
  if (typeof value !== 'string') fail(`to must be "human", "any" or an agent's name${got(value)}.`);
  const wanted = collapse(dropInvisible(value));
  const lower = wanted.toLowerCase();
  if (lower === 'human' || lower === 'any') return lower;
  const named = ([, a]) => typeof a.name === 'string' && a.name.toLowerCase() === lower;
  const entries = Object.entries(ctx.reg.agents);
  const byId = getAgent(ctx.reg, wanted);
  const [id, agent] = byId
    ? [wanted, byId]
    : entries.find((e) => e[1].endedAt == null && named(e)) ?? entries.find(named) ?? [null, null];
  if (!agent) fail(`Unknown recipient ${echo(value)}. Use "human", "any" or an active agent's name.`);
  if (id === ctx.agentId) fail('You cannot address a question to yourself; ask "any" or the human.');
  if (agent.endedAt != null) fail(`${agent.name}'s session has ended; ask "any" or the human.`);
  return id;
}

/** The open question an answer replies to: its id is text, and it is open on this same task (§4). */
function answeredQuestion(ctx, t, value) {
  if (value === undefined) {
    fail(`replyTo is required for an answer: the id of the question, such as "m12". get_task shows the open questions on #${t.id}.`);
  }
  if (typeof value !== 'string') fail(`replyTo must be a message id such as "m12"${got(value)}.`);
  const id = value.trim();
  const question = t.openQuestions.find((q) => q.id === id);
  if (question) return question;
  const elsewhere = Object.values(ctx.state.tasks).find((o) => o.openQuestions.some((q) => q.id === id));
  if (elsewhere) fail(`${echo(id)} is an open question on #${elsewhere.id}, not on #${t.id}; post the answer on #${elsewhere.id}.`);
  return fail(`${echo(id)} is not an open question on #${t.id}; get_task shows its open questions and their ids.`);
}

/**
 * post_message (§8, §4). A question blocks its task until an answer names it in replyTo; `to` goes
 * only with questions (default "any") and `replyTo` only with answers. Questions are refused on
 * done tasks. A question to the human is answered only with the human's words (relayedFromHuman:
 * true); relayedFromHuman goes with answers and comments, never with a question.
 * @param {Ctx} ctx
 */
export function postMessage(ctx, input) {
  requireActor(ctx);
  const f = fieldsOf(input, FIELDS.post);
  const t = getTask(ctx, given(f, 'taskId'), 'taskId');
  const kind = given(f, 'kind') ?? 'comment';
  if (!MESSAGE_KINDS.includes(kind)) fail(`kind must be "comment", "question" or "answer"${got(kind)}.`);
  const text = cleanText(given(f, 'text'), 'text');
  const relayedFromHuman = flag(given(f, 'relayedFromHuman'), 'relayedFromHuman') ?? false;
  const to = given(f, 'to');
  const replyTo = given(f, 'replyTo');
  if (to !== undefined && kind !== 'question') {
    fail(`to is only used with kind "question"; leave it out of ${kind === 'answer' ? 'an answer, which goes to the asker' : 'a comment'}.`);
  }
  if (replyTo !== undefined && kind !== 'answer') fail('replyTo is only used with kind "answer"; post kind "answer" to answer a question.');
  // false is what a question is anyway, so only true is refused
  if (relayedFromHuman && kind === 'question') {
    fail('relayedFromHuman is only used with kind "answer" or "comment"; a question is always your own. Post the human\'s words as a comment.');
  }
  if (kind === 'question' && t.done) fail(`#${t.id} is done; ask on your own task, or create a follow-up task.`);
  /** @type {Record<string, any>} */
  const extra = { relayedFromHuman };
  if (kind === 'question') extra.to = resolveRecipient(ctx, to ?? 'any');
  if (kind === 'answer') {
    const question = answeredQuestion(ctx, t, replyTo);
    if (question.to === 'human' && !relayedFromHuman) {
      fail(`#${t.id}'s question is for the human; ask them, then post their words with relayedFromHuman: true.`);
    }
    extra.replyTo = question.id;
  }
  return { events: [messageEvent(ctx, t.id, kind, text, extra)], result: { taskId: t.id, kind } };
}

/**
 * complete_task (§8, §5, §10). Only the holder completes: an unclaimed task is claimed first, so the
 * approval and dependency checks of claiming always apply. Open questions are closed with a system
 * note per asker that lists them (§5), addressed to that asker; the note for the completer's own
 * questions is addressed to nobody, so an agent is never pinged about its own action. Each
 * dependent that no longer waits on any dependency gets a note:
 * "unblocked" (about: 'unblocked') when nothing else holds it back, otherwise that it still waits
 * for the human's approval or still has an open question. A dependency on a task that does not
 * exist counts as satisfied (derive.blockers).
 * @param {Ctx} ctx
 */
export function completeTask(ctx, input) {
  const me = requireActor(ctx);
  const f = fieldsOf(input, FIELDS.complete);
  const t = getTask(ctx, given(f, 'id'));
  if (t.kind === 'epic') fail(`#${t.id} is an epic; epics are not completed, their progress follows their tasks.`);
  if (t.done) fail(`#${t.id} is already done.`);
  if (t.assignee !== ctx.agentId) {
    if (!t.assignee) fail(`Claim #${t.id} first (claim_task), then complete it.`);
    if (liveOwner(ctx, t)) fail(`#${t.id} is claimed by ${holderName(ctx, t)}; only they can complete it.`);
    fail(`#${t.id} is ${endedHolder(ctx, t)}; claim it with takeOver: true if the human asked, then complete it.`);
  }
  const summary = cleanText(given(f, 'summary'), 'summary');
  const events = [];
  /** @type {Map<string | null, string[]>} question ids by asker */
  const asked = new Map();
  for (const q of t.openQuestions) asked.set(q.author ?? null, [...(asked.get(q.author ?? null) ?? []), q.id]);
  for (const [asker, ids] of asked) {
    const which = ids.length === 1 ? `Open question ${ids[0]} was` : `Open questions ${ids.join(', ')} were`;
    const to = asker === ctx.agentId ? null : asker;
    events.push(systemNote(t.id, `${which} closed because #${t.id} was completed.`, { closesQuestions: true, to }));
  }
  events.push(messageEvent(ctx, t.id, 'summary', summary));
  events.push({ type: 'task.completed', actor: ctx.agentId, data: { id: t.id, summary, completedByName: me.name } });
  const pending = (id) => id !== t.id && Object.hasOwn(ctx.state.tasks, id) && !ctx.state.tasks[id].done;
  const unblocked = [];
  for (const other of Object.values(ctx.state.tasks)) {
    if (other.done || !other.dependsOn.includes(t.id) || other.dependsOn.some(pending)) continue;
    if (!other.approved) {
      // in Backlog: nothing is unblocked until the human approves it
      events.push(systemNote(other.id, `#${t.id} is done — #${other.id} no longer waits on dependencies; it still waits for the human's approval.`));
      continue;
    }
    const open = other.openQuestions.length;
    if (open) {
      // no dependency holds it back any more, but a question still does: say so, and do not announce "unblocked"
      const questions = open === 1 ? 'an open question' : `${open} open questions`;
      events.push(systemNote(other.id, `#${t.id} is done — #${other.id} no longer waits on dependencies, but still has ${questions}.`));
      continue;
    }
    unblocked.push(other.id);
    events.push(systemNote(other.id, `#${t.id} is done — #${other.id} is unblocked.`, { about: 'unblocked' }));
  }
  return { events, result: { id: t.id, unblocked } };
}

/**
 * release_task (§8, §10). The note is stored as the task's handoff. The holder releases its task;
 * another agent may release a claim whose holder's session has ended (or that the registry no
 * longer knows), and the former holder then gets a note addressed to it.
 * @param {Ctx} ctx
 */
export function releaseTask(ctx, input) {
  const me = requireActor(ctx);
  const f = fieldsOf(input, FIELDS.release);
  const t = getTask(ctx, given(f, 'id'));
  if (t.done) fail(`#${t.id} is done; there is nothing to release.`);
  if (!t.assignee) fail(`#${t.id} is not claimed; there is nothing to release.`);
  if (liveOwner(ctx, t)) fail(`#${t.id} is claimed by ${holderName(ctx, t)}; only they can release it.`);
  const note = cleanText(given(f, 'note'), 'note');
  const events = [messageEvent(ctx, t.id, 'handoff', note)];
  if (t.assignee !== ctx.agentId) {
    const name = holderName(ctx, t);
    const whose = name === null
      ? 'the claim of a session that had ended'
      : `${name === me.name ? `the earlier ${name}` : name}'s claim, whose session had ended`;
    events.push(systemNote(t.id, `${me.name} released ${whose}.`, { to: t.assignee }));
  }
  events.push({ type: 'task.released', actor: ctx.agentId, data: { id: t.id, reason: 'manual' } });
  return { events, result: { id: t.id } };
}

/**
 * A checklist item's text (§9, §14): cut to ITEM_RAW_MAX characters before any other work, then one
 * line, normalized and redacted like a title, and capped at ITEM_MAX. When the cut splits a word,
 * that word is dropped, so a secret cut in two cannot keep a part that redaction no longer
 * recognizes; a text that is one long word keeps its cut. '' when nothing is left.
 */
function checklistText(value) {
  let s = value;
  if (s.length > ITEM_RAW_MAX) {
    s = s.slice(0, ITEM_RAW_MAX);
    if (!/\s/.test(value[ITEM_RAW_MAX])) {
      let end = s.length;
      while (end > 0 && !/\s/.test(s[end - 1])) end -= 1;
      if (end > 0) s = s.slice(0, end);
    }
  }
  const kept = dropInvisible(s);
  if (!collapse(kept)) return '';
  return settle(collapse(redact(kept)), ITEM_MAX);
}

/**
 * Mirrors the agent's todo list into its claimed task (§9). Called by a hook, so bad input never
 * throws: items without text are skipped, an item is done only when `done` is exactly true, and
 * anything but a list changes nothing. At most CHECKLIST_MAX items; no event when nothing changes.
 * @param {Ctx} ctx @param {unknown} items [{ text, done }]
 */
export function syncChecklist(ctx, items) {
  const t = claimedBy(ctx.state, ctx.agentId);
  if (!t || !Array.isArray(items) || !liveActor(ctx)) return { events: [] };
  const clean = [];
  for (const item of items.slice(0, RAW_LIST_MAX)) {
    if (clean.length === CHECKLIST_MAX) break;
    const text = typeof item?.text === 'string' ? checklistText(item.text) : '';
    if (text) clean.push({ text, done: item.done === true });
  }
  const same = clean.length === t.checklist.length && clean.every((i, n) => i.text === t.checklist[n].text && i.done === t.checklist[n].done);
  if (same) return { events: [] };
  return { events: [{ type: 'task.checklist', actor: ctx.agentId, data: { id: t.id, items: clean } }] };
}

/**
 * Records the first touch of a file (a repository path from the hook) on the agent's claimed task.
 * The path is stored and compared without hidden, control, bidi or zero-width characters and cut
 * to PATH_MAX characters. Stops at the reducer's FILES_LIMIT: past it, new paths could not be stored
 * and the log would only grow.
 * @param {Ctx} ctx @param {unknown} repoPath
 */
export function touchTaskFile(ctx, repoPath) {
  if (typeof repoPath !== 'string') return { events: [] };
  const path = capAt(dropInvisible(repoPath).replace(/[\t\n\v\f\r]/g, ''), PATH_MAX);
  const t = claimedBy(ctx.state, ctx.agentId);
  if (!path || !t || !liveActor(ctx) || t.files.length >= FILES_LIMIT || t.files.some((f) => f.path === path)) return { events: [] };
  return { events: [{ type: 'task.file', actor: ctx.agentId, data: { id: t.id, path, by: ctx.agentId } }] };
}
