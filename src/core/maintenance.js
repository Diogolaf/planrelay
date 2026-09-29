import fs from 'node:fs';
import path from 'node:path';
import { currentHost, getAgent, nameOf, statusOf } from './agents.js';
import { pidAlive } from './mutex.js';
import { samePath } from './paths.js';

const MIN = 60_000;
const DAY = 86_400_000;
/** A claim folder must stay missing this long before its claim is released (§10). */
export const MISSING_GRACE_MS = 10 * MIN;
/** The file-system sweep (claim folders) runs at most once in this interval (§10). */
export const SWEEP_MS = MIN;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isObj(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * An event that posts a system message on a task. `extra` adds fields (such as `to`), but never
 * replaces the task, author, kind or text.
 */
export function systemMessage(taskId, text, extra = {}) {
  return {
    type: 'message.posted',
    actor: 'system',
    data: { message: { mentions: [], ...extra, taskId, author: 'system', authorName: 'system', kind: 'system', text } },
  };
}

/** The code of the error stat gives for a path ('UNKNOWN' without one), or null when it exists. */
function statError(p) {
  try {
    fs.statSync(p);
    return null;
  } catch (err) {
    return /** @type {any} */ (err)?.code ?? 'UNKNOWN';
  }
}

const notFound = (code) => code === 'ENOENT' || code === 'ENOTDIR';

/**
 * True only when the folder is confirmed missing: stat fails with ENOENT or ENOTDIR, and a folder
 * above it still exists, so the drive, share or mount that held it is there. Anything else proves
 * nothing and counts as present: a folder that cannot be read (EACCES), a timeout, and a drive
 * that is unplugged or disconnected or a share that is unreachable (Windows reports ENOENT for
 * those, and for their root too). Known gap: an unmounted POSIX mount point is an empty folder
 * that exists, so a folder inside it still counts as missing.
 * A path that is not absolute is never missing.
 * @param {string} p absolute path @returns {boolean}
 */
export function folderMissing(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false; // a relative path proves nothing
  if (!notFound(statError(p))) return false;
  for (let dir = p; ;) {
    const up = path.dirname(dir);
    if (up === dir) return false; // even the root is not found: the volume is not there
    dir = up;
    const code = statError(dir);
    if (code === null) return true;
    if (!notFound(code)) return false;
  }
}

/**
 * When a claimed task last saw activity: the latest finite time among the claim's start, the
 * task's recorded activity and its owner's lastSeen. When none is usable (corrupt data), the
 * task's own updatedAt, then createdAt, then 0, so such a claim still times out and never
 * becomes permanent.
 * @param {import('./reduce.js').Task} task @param {import('./store.js').Registry} reg @returns {number}
 */
export function lastActivity(task, reg) {
  const owner = getAgent(reg, task.assignee);
  const stamps = [task.claim?.since, own(reg.activity, task.id), owner?.lastSeen].filter(Number.isFinite);
  if (stamps.length) return Math.max(...stamps);
  return [task.updatedAt, task.createdAt].find(Number.isFinite) ?? 0;
}

/**
 * When a claim is due for release after claimTimeoutHours without activity (§10): its lastActivity
 * plus the timeout. The dashboard counts down to it (queries.needsHuman).
 * @param {import('./reduce.js').Task} task @param {import('./store.js').Registry} reg
 * @param {import('./config.js').Config} cfg @returns {number}
 */
export function claimReleaseAt(task, reg, cfg) {
  return lastActivity(task, reg) + cfg.claimTimeoutHours * 3_600_000;
}

/**
 * True when housekeeping releases the claim for inactivity at `now`: once now is past
 * claimReleaseAt. The one rule for both housekeeping and the dashboard's stalled list.
 * @param {import('./reduce.js').Task} task @param {import('./store.js').Registry} reg
 * @param {import('./config.js').Config} cfg @param {number} now @returns {boolean}
 */
export function claimTimedOut(task, reg, cfg, now) {
  return now > claimReleaseAt(task, reg, cfg);
}

/** The agent's last activity for the inactivity rule: lastSeen, else firstSeen, else never. */
const seenAt = (a) => [a.lastSeen, a.firstSeen].find(Number.isFinite) ?? -Infinity;

/**
 * Housekeeping inside every write (§10); transact runs it first (`before`). Mutates the registry;
 * returns events to append. It only takes decisions it can prove on this host:
 * - Agents: a live agent without activity for claimTimeoutHours is ended, on any host. A dead host
 *   process ends an agent only on the writer's own host (pids of other hosts mean nothing here).
 * - Claims: released after claimTimeoutHours without activity (lastActivity). Released when the
 *   folder is removed only if the owner is on this host and not active, and the folder was
 *   confirmed missing on sweeps at least 10 minutes apart (first sighting kept in `reg.missing`).
 * - The file-system sweep runs at most once a minute (`reg.sweptAt`).
 * - Release messages are addressed to the former holder and name it.
 * - Pruned: agents ended over 7 days ago without a claim, touches that no longer lock (older
 *   than twice lockMinutes, or with a time that is not usable), activity of finished tasks,
 *   missing-folder sightings of claims that changed.
 * @param {import('./reduce.js').BoardState} state
 * @param {import('./store.js').Registry} reg
 * @param {import('./config.js').Config} cfg
 * @param {number} now
 * @param {{ host?: string, missing?: (p: string) => boolean, alive?: (pid: number) => boolean }} [io]
 *   host: the writer's host (default currentHost()); missing: true only when a folder is confirmed
 *   gone (default folderMissing); alive: whether a pid of this host runs (default pidAlive)
 */
export function maintenance(state, reg, cfg, now, io = {}) {
  const host = io.host ?? currentHost();
  const missing = io.missing ?? folderMissing;
  const alive = io.alive ?? pidAlive;
  const timeoutMs = cfg.claimTimeoutHours * 3_600_000;
  const lockMs = cfg.lockMinutes * MIN;
  // a sweep time in the future (clock skew, corrupt) never blocks the sweep
  const sweep = !(Number.isFinite(reg.sweptAt) && reg.sweptAt <= now && now - reg.sweptAt < SWEEP_MS);
  if (sweep) reg.sweptAt = now;
  if (!isObj(reg.missing) || Object.getPrototypeOf(reg.missing) !== Object.prototype) reg.missing = {};

  for (const a of Object.values(reg.agents)) {
    if (a.endedAt != null) continue;
    const deadHere = a.host === host && Number.isInteger(a.pid) && a.pid > 0 && !alive(a.pid);
    if (deadHere || !(now - seenAt(a) <= timeoutMs)) a.endedAt = now;
  }

  const events = [];
  for (const t of Object.values(state.tasks)) {
    if (!t.assignee || t.done) continue;
    const key = String(t.id);
    let reason = null;
    if (claimTimedOut(t, reg, cfg, now)) reason = 'timeout';
    else if (sweep) {
      const owner = getAgent(reg, t.assignee);
      const folder = t.claim?.folder;
      // only the claim's own host can confirm its folder is gone; a relative path proves nothing
      if (owner && owner.host === host && typeof folder === 'string' && path.isAbsolute(folder)) {
        if (!missing(folder)) delete reg.missing[key];
        else {
          const seen = own(reg.missing, key);
          const since = isObj(seen) && seen.agent === t.assignee && seen.folder === folder
            && Number.isFinite(seen.at) && seen.at <= now ? seen.at : null;
          if (since === null) reg.missing[key] = { agent: t.assignee, folder, at: now };
          else if (now - since >= MISSING_GRACE_MS && statusOf(owner, now, cfg) !== 'active') reason = 'folder-missing';
        }
      }
    }
    if (!reason) continue;
    delete reg.missing[key];
    const holder = nameOf(reg, t.assignee);
    const text =
      reason === 'folder-missing'
        ? `Released ${holder}'s claim: the working folder was removed.`
        : `Released ${holder}'s claim after ${cfg.claimTimeoutHours} h without activity.`;
    events.push(
      systemMessage(t.id, text, { to: t.assignee }),
      { type: 'task.released', actor: 'system', data: { id: t.id, reason } },
    );
  }

  const claimed = new Set(Object.values(state.tasks).filter((t) => t.assignee && !t.done).map((t) => t.assignee));
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.endedAt != null && now - a.endedAt > 7 * DAY && !claimed.has(id)) delete reg.agents[id];
  }
  for (const [file, touch] of Object.entries(reg.touches)) {
    const at = isObj(touch) ? touch.at : NaN;
    if (!Number.isFinite(at) || at > now + lockMs || now - at > 2 * lockMs) delete reg.touches[file];
  }
  for (const id of Object.keys(reg.activity)) {
    const t = own(state.tasks, id);
    if (!t || t.done) delete reg.activity[id];
  }
  for (const [id, seen] of Object.entries(reg.missing)) {
    const t = own(state.tasks, id);
    const current = t && !t.done && isObj(seen) && seen.agent === t.assignee && seen.folder === t.claim?.folder;
    if (!current) delete reg.missing[id];
  }
  return events;
}

/**
 * A session starting in a folder takes over a claim a gone agent left there (§10): of the claims
 * in `folder` whose owner is gone, the one whose owner was seen last. Nothing when the agent
 * already holds a claim. A live agent's claim is never taken over.
 *
 * Precondition: housekeeping ran first in the same write (transact's `before`), and its events
 * were applied to `state`, so claims it released are no longer here and agents it found dead or
 * inactive are already ended.
 * @param {import('./reduce.js').BoardState} state
 * @param {import('./store.js').Registry} reg
 * @param {string} agentId @param {string} folder
 */
export function inheritClaim(state, reg, agentId, folder) {
  const tasks = Object.values(state.tasks);
  if (tasks.some((t) => t.assignee === agentId && !t.done)) return [];
  const lastSeen = (id) => {
    const t = getAgent(reg, id)?.lastSeen;
    return Number.isFinite(t) ? t : 0;
  };
  const candidate = tasks
    .filter((t) => t.assignee && !t.done && t.assignee !== agentId)
    .filter((t) => {
      const owner = getAgent(reg, t.assignee);
      return !owner || owner.endedAt != null; // live owners are left out before samePath reads the file system
    })
    .filter((t) => samePath(t.claim?.folder, folder))
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
    { type: 'task.claimed', actor: agentId, data: { id: candidate.id, agent: agentId, agentName: getAgent(reg, agentId)?.name ?? null, folder } },
  ];
}
