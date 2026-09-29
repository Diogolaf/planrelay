import { nameOf, statusOf } from './agents.js';
import { blockers, wouldCycle } from './derive.js';
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

function getTask(ctx, id) {
  const t = Number.isSafeInteger(id) && Object.hasOwn(ctx.state.tasks, id) ? ctx.state.tasks[id] : undefined;
  return t || fail(`#${id} does not exist.`);
}

function cleanText(value, field, { required = true, max = 20_000 } = {}) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) fail(`${field} is required.`);
  if (s.length > max) fail(`${field} is too long (max ${max} characters).`);
  return redact(s);
}

function uniqueInts(value, field) {
  if (!Array.isArray(value) || !value.every((v) => Number.isSafeInteger(v) && v >= 1)) fail(`${field} must be a list of task ids (whole numbers).`);
  return [...new Set(value)];
}

function cleanLabels(value) {
  if (!Array.isArray(value)) fail('labels must be a list of strings.');
  const out = [...new Set(value.filter((l) => typeof l === 'string').map((l) => l.trim().toLowerCase()).filter(Boolean))];
  if (out.length > 10 || out.some((l) => l.length > 40)) fail('Use at most 10 labels of up to 40 characters.');
  return out;
}

function cleanLinks(value) {
  if (!Array.isArray(value)) fail('links must be a list of { title, target }.');
  return value.slice(0, 20).map((l) => ({
    title: cleanText(l?.title, 'link title', { max: 200 }),
    target: cleanText(l?.target, 'link target', { max: 2000 }),
  }));
}

function checkParent(ctx, parentId, kind, selfId) {
  if (parentId == null) return null;
  const p = getTask(ctx, parentId);
  if (p.id === selfId) fail('A task cannot be its own parent.');
  if (p.kind !== 'epic') fail(`#${p.id} is not an epic.`);
  if (kind === 'epic') {
    if (p.parent != null) fail(`#${p.id} is already a sub-epic; epics nest one level only.`);
    if (selfId != null && Object.values(ctx.state.tasks).some((t) => t.kind === 'epic' && t.parent === selfId)) {
      fail(`#${selfId} has sub-epics, so it cannot become a sub-epic.`);
    }
  }
  return p.id;
}

function checkDependency(ctx, selfId, depId) {
  const dep = getTask(ctx, depId);
  if (dep.kind === 'epic') fail(`#${depId} is an epic; dependencies link tasks only.`);
  if (depId === selfId) fail('A task cannot depend on itself.');
  if (selfId != null && wouldCycle(ctx.state.tasks, selfId, depId)) fail(`#${selfId} → #${depId} would create a dependency cycle.`);
}

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

function messageEvent(ctx, taskId, kind, content, extra = {}) {
  return {
    type: 'message.posted',
    actor: ctx.agentId,
    data: {
      message: {
        taskId, author: ctx.agentId, kind, to: null, replyTo: null, relayedFromHuman: false,
        mentions: mentionsIn(content, ctx.state, taskId), text: content, ...extra,
      },
    },
  };
}

/** @param {Ctx} ctx */
export function createTask(ctx, input) {
  const kind = input.kind ?? 'task';
  if (kind !== 'task' && kind !== 'epic') fail('kind must be "task" or "epic".');
  const title = cleanText(input.title, 'title', { max: 200 });
  const description = cleanText(input.description ?? '', 'description', { required: false });
  const parent = checkParent(ctx, input.parent ?? null, kind, null);
  const dependsOn = uniqueInts(input.dependsOn ?? [], 'dependsOn');
  if (kind === 'epic' && dependsOn.length) fail('Epics cannot have dependencies.');
  for (const d of dependsOn) checkDependency(ctx, null, d);
  const labels = cleanLabels(input.labels ?? []);
  const byHuman = input.requestedByHuman === true;
  const id = ctx.state.nextId;
  const approved = kind === 'epic' || byHuman || !ctx.cfg.agentTasksNeedApproval;
  const task = {
    id, kind, title, description, parent, labels, dependsOn,
    origin: byHuman ? 'human' : 'agent', createdBy: byHuman ? 'human' : ctx.agentId, approved, rank: id,
  };
  return { events: [{ type: 'task.created', actor: ctx.agentId, data: { task } }], result: { id, approved } };
}

/** @param {Ctx} ctx */
export function updateTask(ctx, input) {
  const t = getTask(ctx, input.id);
  /** @type {Record<string, any>} */
  const changes = {};
  if (input.title !== undefined) changes.title = cleanText(input.title, 'title', { max: 200 });
  if (input.description !== undefined) changes.description = cleanText(input.description, 'description', { required: false });
  if (input.parent !== undefined) changes.parent = checkParent(ctx, input.parent, t.kind, t.id);
  if (input.labels !== undefined) changes.labels = cleanLabels(input.labels);
  if (input.links !== undefined) changes.links = cleanLinks(input.links);
  if (input.rank !== undefined) {
    if (!Number.isFinite(input.rank)) fail('rank must be a number.');
    changes.rank = input.rank;
  }
  if (input.addDependsOn !== undefined || input.removeDependsOn !== undefined) {
    if (t.kind === 'epic') fail('Epics cannot have dependencies.');
    const deps = new Set(t.dependsOn);
    for (const d of uniqueInts(input.removeDependsOn ?? [], 'removeDependsOn')) deps.delete(d);
    for (const d of uniqueInts(input.addDependsOn ?? [], 'addDependsOn')) {
      if (!deps.has(d)) checkDependency(ctx, t.id, d);
      deps.add(d);
    }
    changes.dependsOn = [...deps];
  }
  const events = [];
  if (Object.keys(changes).length) events.push({ type: 'task.updated', actor: ctx.agentId, data: { id: t.id, changes } });
  if (input.approved !== undefined) {
    if (typeof input.approved !== 'boolean') fail('approved must be true or false.');
    if (!input.approved && t.assignee) fail(`#${t.id} is claimed; release it first.`);
    if (input.approved !== t.approved) {
      events.push({ type: 'task.approved', actor: ctx.agentId, data: { id: t.id, approved: input.approved } });
    }
  }
  if (!events.length) fail('Nothing to update.');
  return { events, result: { id: t.id } };
}
