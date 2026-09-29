import { getAgent, statusOf } from './agents.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Would editing `file` collide with another agent's recent work (§10 File locks)? It does when
 * another agent touched the file within lockMinutes, on a different task (two agents without a
 * task collide too), and that agent is active (`auto`) or anything but gone (`always`); `off`
 * never locks. The asking agent always counts as active, whatever its own lastSeen says. A touch
 * whose time is not a number, or lies more than lockMinutes ahead of now, has expired.
 * @param {{ reg: import('./store.js').Registry, cfg: import('./config.js').Config, now: number,
 *   agentId: string, taskId: number | null, file: string }} q file: the lock key (paths.lockKey)
 * @returns {{ agent: import('./agents.js').Agent, task: number | null } | null}
 */
export function lockConflict({ reg, cfg, now, agentId, taskId, file }) {
  if (cfg.locks === 'off') return null;
  const touch = Object.hasOwn(reg.touches, file) ? reg.touches[file] : undefined;
  if (!isObj(touch) || touch.agent === agentId) return null;
  const lockMs = cfg.lockMinutes * 60_000;
  if (!Number.isFinite(touch.at) || touch.at > now + lockMs || now - touch.at > lockMs) return null;
  const other = getAgent(reg, touch.agent);
  const status = statusOf(other, now, cfg);
  if (status === 'gone' || (status === 'idle' && cfg.locks !== 'always')) return null;
  if (touch.task != null && touch.task === taskId) return null;
  return { agent: /** @type {import('./agents.js').Agent} */ (other), task: touch.task ?? null };
}

/** Remembers who touched a file last, and marks the task as active. */
export function recordTouch(reg, { agentId, taskId, file, now }) {
  // defineProperty: plain assignment with the key "__proto__" would change the prototype, not add an entry
  Object.defineProperty(reg.touches, file, {
    value: { agent: agentId, task: taskId ?? null, at: now },
    writable: true, enumerable: true, configurable: true,
  });
  if (taskId != null) reg.activity[taskId] = now;
}
