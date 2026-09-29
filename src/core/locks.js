import { activeCount, statusOf } from './agents.js';

/**
 * Would editing `file` collide with another active agent's recent work (§10)?
 * @returns {{ agent: import('./agents.js').Agent, task: number | null } | null}
 */
export function lockConflict({ reg, cfg, now, agentId, taskId, file }) {
  if (cfg.locks === 'off') return null;
  if (cfg.locks === 'auto' && activeCount(reg, now, cfg) < 2) return null;
  const touch = Object.hasOwn(reg.touches, file) ? reg.touches[file] : undefined;
  if (!touch || touch.agent === agentId) return null;
  if (now - touch.at > cfg.lockMinutes * 60_000) return null;
  const other = Object.hasOwn(reg.agents, touch.agent) ? reg.agents[touch.agent] : undefined;
  if (statusOf(other, now, cfg) !== 'active') return null;
  if (touch.task != null && touch.task === taskId) return null;
  return { agent: other, task: touch.task };
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
