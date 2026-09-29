import fs from 'node:fs';
import { nameOf } from './agents.js';
import { pidAlive } from './mutex.js';
import { samePath } from './paths.js';

const DAY = 86_400_000;

const own = (obj, key) => (Object.hasOwn(obj, key) ? obj[key] : undefined);

/** An event that posts a system message on a task. */
export function systemMessage(taskId, text, extra = {}) {
  return {
    type: 'message.posted',
    actor: 'system',
    data: { message: { taskId, author: 'system', kind: 'system', text, mentions: [], ...extra } },
  };
}

/**
 * Housekeeping inside every write (§10). Mutates the registry; returns events to append.
 * @param {import('./reduce.js').BoardState} state
 * @param {import('./store.js').Registry} reg
 * @param {import('./config.js').Config} cfg
 * @param {number} now
 * @param {{ exists?: (p: string) => boolean, alive?: (pid: number) => boolean }} [io]
 */
export function maintenance(state, reg, cfg, now, io = {}) {
  const exists = io.exists ?? fs.existsSync;
  const alive = io.alive ?? pidAlive;
  for (const a of Object.values(reg.agents)) {
    if (!a.endedAt && a.pid != null && !alive(a.pid)) a.endedAt = now;
  }

  const events = [];
  for (const t of Object.values(state.tasks)) {
    if (!t.assignee || t.done) continue;
    const owner = own(reg.agents, t.assignee);
    // Only finite timestamps count; if none is usable (corrupt data), treat the claim as fresh.
    const stamps = [t.claim?.since, own(reg.activity, t.id), owner?.lastSeen].filter(Number.isFinite);
    const last = stamps.length ? Math.max(...stamps) : now;
    let reason = null;
    if (t.claim?.folder && !exists(t.claim.folder)) reason = 'folder-missing';
    else if (now - last > cfg.claimTimeoutHours * 3_600_000) reason = 'timeout';
    if (!reason) continue;
    const text =
      reason === 'folder-missing'
        ? 'Released: the working folder was removed.'
        : `Released after ${cfg.claimTimeoutHours} h without activity.`;
    events.push(systemMessage(t.id, text), { type: 'task.released', actor: 'system', data: { id: t.id, reason } });
  }

  const claimed = new Set(Object.values(state.tasks).filter((t) => t.assignee && !t.done).map((t) => t.assignee));
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.endedAt && now - a.endedAt > 7 * DAY && !claimed.has(id)) delete reg.agents[id];
  }
  for (const [file, touch] of Object.entries(reg.touches)) {
    if (now - touch.at > 2 * cfg.lockMinutes * 60_000) delete reg.touches[file];
  }
  for (const id of Object.keys(reg.activity)) {
    const t = own(state.tasks, id);
    if (!t || t.done) delete reg.activity[id];
  }
  return events;
}

/** A session starting in a folder takes over a claim a gone agent left there (§10). */
export function inheritClaim(state, reg, agentId, folder) {
  const tasks = Object.values(state.tasks);
  if (tasks.some((t) => t.assignee === agentId && !t.done)) return [];
  const lastSeen = (id) => own(reg.agents, id)?.lastSeen ?? 0;
  const candidate = tasks
    .filter((t) => t.assignee && !t.done && t.assignee !== agentId && samePath(t.claim?.folder, folder))
    .filter((t) => !own(reg.agents, t.assignee) || own(reg.agents, t.assignee).endedAt)
    .sort((x, y) => lastSeen(y.assignee) - lastSeen(x.assignee))[0];
  if (!candidate) return [];
  const me = nameOf(reg, agentId);
  const previous = nameOf(reg, candidate.assignee);
  const text =
    me === previous
      ? `${me} continues this task in a new session.`
      : `${me} continues this task in the same folder (taken over from ${previous}).`;
  return [
    systemMessage(candidate.id, text),
    { type: 'task.claimed', actor: agentId, data: { id: candidate.id, agent: agentId, folder } },
  ];
}
