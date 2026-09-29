import { samePath } from './paths.js';

/** Display names and colors (dark tones, white initials at ≥ 4.5:1). */
export const PALETTE = [
  ['Amber', '#A45F00'], ['Jade', '#17735A'], ['Cobalt', '#2F4DB5'], ['Plum', '#7A3E8E'], ['Rust', '#A3401F'],
  ['Moss', '#4F6B1F'], ['Indigo', '#4338A8'], ['Teal', '#0F6E6E'], ['Ruby', '#A1234A'], ['Slate', '#475569'],
];

/**
 * @typedef {{ id: string, name: string, color: string, folder: string | null, pid: number | null,
 *   branch: string | null, firstSeen: number, lastSeen: number, cursor: number, endedAt: number | null }} Agent
 * @typedef {import('./store.js').Registry} Registry
 */

/** The agent with this id, as an own property only (never via Object.prototype). @returns {Agent | undefined} */
function findAgent(reg, id) {
  return typeof id === 'string' && Object.hasOwn(reg.agents, id) ? reg.agents[id] : undefined;
}

/** @param {Agent | undefined} agent @returns {'active' | 'idle' | 'gone'} */
export function statusOf(agent, now, cfg) {
  if (!agent || agent.endedAt) return 'gone';
  return now - agent.lastSeen <= cfg.idleMinutes * 60_000 ? 'active' : 'idle';
}

export function activeCount(reg, now, cfg) {
  return Object.values(reg.agents).filter((a) => statusOf(a, now, cfg) === 'active').length;
}

function pickName(reg) {
  const live = Object.values(reg.agents).filter((a) => !a.endedAt);
  const used = new Set(live.map((a) => a.name));
  const free = PALETTE.find(([name]) => !used.has(name));
  if (free) return free;
  const [name, color] = PALETTE[live.length % PALETTE.length];
  let n = 2;
  while (used.has(`${name} ${n}`)) n++;
  return [`${name} ${n}`, color];
}

/**
 * Registers or refreshes an agent. Mutates the registry.
 * @param {Registry} reg
 * @param {{ id: string, folder?: string | null, pid?: number | null, branch?: string | null }} info
 * @returns {Agent}
 */
export function touchAgent(reg, info, now) {
  if (typeof info?.id !== 'string') throw new TypeError('touchAgent: info.id must be a string');
  let a = findAgent(reg, info.id);
  if (!a) {
    const [name, color] = pickName(reg);
    a = {
      id: info.id, name, color, folder: info.folder ?? null, pid: info.pid ?? null, branch: info.branch ?? null,
      firstSeen: now, lastSeen: now, cursor: now, endedAt: null,
    };
    // defineProperty: plain assignment with the id "__proto__" would change the prototype, not add an entry
    Object.defineProperty(reg.agents, info.id, { value: a, writable: true, enumerable: true, configurable: true });
  }
  a.lastSeen = now;
  a.endedAt = null;
  if (info.folder) a.folder = info.folder;
  if (info.pid != null) a.pid = info.pid;
  if (info.branch !== undefined) a.branch = info.branch;
  return a;
}

export function endAgent(reg, id, now) {
  const a = findAgent(reg, id);
  if (a) a.endedAt = now;
}

/** Which registered agent an MCP server acts for (§4 Identity). Null means "register a new one". */
export function resolveAgentId(reg, q) {
  const s = findAgent(reg, q.sessionId);
  if (s && !s.endedAt) return s.id;
  const live = Object.values(reg.agents)
    .filter((a) => !a.endedAt)
    .sort((x, y) => y.lastSeen - x.lastSeen);
  const byPid = q.pid != null ? live.find((a) => a.pid === q.pid) : undefined;
  if (byPid) return byPid.id;
  const byFolder = q.folder ? live.find((a) => samePath(a.folder, q.folder)) : undefined;
  return byFolder ? byFolder.id : null;
}

/** Human-readable author name for texts shown to agents. */
export function nameOf(reg, id) {
  if (id === 'human') return 'the human';
  if (id === 'system') return 'system';
  return findAgent(reg, id)?.name ?? 'an earlier agent';
}
