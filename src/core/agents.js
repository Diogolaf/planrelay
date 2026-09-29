import os from 'node:os';
import { samePath } from './paths.js';

/**
 * Display names and colors (dark tones, white initials at ≥ 4.5:1). Frozen, and only ever
 * appended to: registries keep names already handed out, and their order decides new names.
 */
export const PALETTE = Object.freeze([
  ['Amber', '#A45F00'], ['Jade', '#17735A'], ['Cobalt', '#2F4DB5'], ['Plum', '#7A3E8E'], ['Rust', '#A3401F'],
  ['Moss', '#4F6B1F'], ['Indigo', '#4338A8'], ['Teal', '#0F6E6E'], ['Ruby', '#A1234A'], ['Slate', '#475569'],
].map((entry) => Object.freeze(entry)));

/**
 * An agent in the registry. host: where it runs (currentHost()), null when never recorded;
 * cursor: the board sequence number up to which it has been shown updates (§5 Agent, §9), never a
 * time, since times can arrive out of commit order; prevCursor: the cursor before its last
 * advance, so a batch cut off by the ping cap can be shown again; endedAt: null while live.
 * The registry reader drops a cursor or prevCursor that is not a whole number of 0 or more.
 * @typedef {{ id: string, name: string, color: string, folder: string | null, pid: number | null,
 *   host: string | null, branch: string | null, firstSeen: number, lastSeen: number, cursor: number,
 *   prevCursor?: number, endedAt: number | null }} Agent
 * @typedef {import('./store.js').Registry} Registry
 */

/**
 * The host this process runs on (§10 Hosts): platform, machine name (lower case) and WSL
 * distribution. A container has its own machine name. Pids and folders are only comparable
 * between agents of the same host.
 * @param {Record<string, string | undefined>} [env]
 */
export function currentHost(env = process.env) {
  return `${process.platform}:${os.hostname().toLowerCase()}:${env.WSL_DISTRO_NAME ?? ''}`;
}

/**
 * The agent with this id: a non-empty string that is an own key of the registry (never a
 * property of Object.prototype, such as "__proto__" or "toString").
 * @param {Registry} reg @param {unknown} id @returns {Agent | undefined}
 */
export function getAgent(reg, id) {
  return typeof id === 'string' && id !== '' && Object.hasOwn(reg.agents, id) ? reg.agents[id] : undefined;
}

/** An agent is live until it has an end time (0 counts as one). */
const isLive = (a) => a.endedAt == null;
/** A time used for "most recent" comparisons: never later than now (clock skew), -Infinity when unusable. */
const upTo = (t, now) => (Number.isFinite(t) ? Math.min(t, now) : -Infinity);
/** Sort order for agents: most recently seen first. */
const newestFirst = (now) => (x, y) => upTo(y.lastSeen, now) - upTo(x.lastSeen, now);

/**
 * active: seen within idleMinutes; idle: seen earlier, or at a time more than idleMinutes ahead
 * of now (a skewed or corrupt clock is not proof of activity); gone: ended, or unknown.
 * @param {Agent | undefined} agent @param {number} now @param {{ idleMinutes: number }} cfg
 * @returns {'active' | 'idle' | 'gone'}
 */
export function statusOf(agent, now, cfg) {
  if (!agent || agent.endedAt != null) return 'gone';
  const window = cfg.idleMinutes * 60_000;
  const age = now - agent.lastSeen;
  return age <= window && age >= -window ? 'active' : 'idle';
}

export function activeCount(reg, now, cfg) {
  return Object.values(reg.agents).filter((a) => statusOf(a, now, cfg) === 'active').length;
}

/**
 * A name and color for an agent (§4 Names), never the name of another live agent:
 * 1. continuity: the name of the most recently seen gone agent in the same folder;
 * 2. a palette name no registry entry holds;
 * 3. the palette name whose holders ended longest ago;
 * 4. a numbered name no registry entry holds: "Amber 2", "Jade 2" … "Slate 2", "Amber 3" …
 * @param {Registry} reg @param {string | null | undefined} folder @param {number} now
 * @param {string} selfId the agent being named; its own entry is ignored
 * @returns {[string, string]}
 */
function pickName(reg, folder, now, selfId) {
  const others = Object.entries(reg.agents).filter(([id]) => id !== selfId).map(([, a]) => a);
  const liveNames = new Set(others.filter(isLive).map((a) => a.name));
  if (folder) {
    // live agents are left out before samePath, which may read the file system
    const prev = others
      .filter((a) => !isLive(a) && a.folder && typeof a.name === 'string' && typeof a.color === 'string')
      .sort(newestFirst(now))
      .find((a) => samePath(a.folder, folder));
    if (prev && !liveNames.has(prev.name)) return [prev.name, prev.color];
  }
  const held = new Set(others.map((a) => a.name));
  const fresh = PALETTE.find(([name]) => !held.has(name));
  if (fresh) return [fresh[0], fresh[1]];
  /** @type {[string, string] | null} */
  let oldest = null;
  let oldestEnd = Infinity;
  for (const [name, color] of PALETTE) {
    if (liveNames.has(name)) continue;
    // a name is as recent as its latest ending; an unusable end time counts as long ago
    const ended = Math.max(...others.filter((a) => a.name === name).map((a) => (Number.isFinite(a.endedAt) ? Math.min(a.endedAt, now) : 0)));
    if (ended < oldestEnd) [oldest, oldestEnd] = [[name, color], ended];
  }
  if (oldest) return oldest;
  for (let n = 2; ; n++) {
    const free = PALETTE.find(([name]) => !held.has(`${name} ${n}`));
    if (free) return [`${free[0]} ${n}`, free[1]];
  }
}

/**
 * Registers or refreshes an agent (§4 Identity, Uniqueness, Names). Mutates the registry.
 * - A pid (whole number above 0) given together with a host ends every other live agent with the
 *   same pid on the same host first: one host process has one live agent (/clear, pid reuse).
 * - A new agent is named by pickName; an ended agent that comes back keeps its name unless a live
 *   agent took it meanwhile, then it is renamed.
 * - Fields left out (or null for folder, pid and host) keep their stored value.
 * - A new agent's cursor starts at info.seq, the board's current sequence number (0 when it is not
 *   a whole number of 0 or more), so it is never pinged about older messages. A touch never moves
 *   an existing agent's cursor: one that comes back is shown what it missed.
 * @param {Registry} reg
 * @param {{ id: string, folder?: string | null, pid?: number | null, host?: string | null, branch?: string | null,
 *   seq?: number }} info
 * @param {number} now
 * @returns {Agent}
 */
export function touchAgent(reg, info, now) {
  if (typeof info?.id !== 'string' || info.id === '') throw new TypeError('touchAgent: info.id must be a non-empty string');
  const { id } = info;
  if (Number.isInteger(info.pid) && info.pid > 0 && info.host) {
    for (const [otherId, other] of Object.entries(reg.agents)) {
      if (otherId !== id && isLive(other) && other.pid === info.pid && other.host === info.host) other.endedAt = now;
    }
  }
  let a = getAgent(reg, id);
  if (!a) {
    const [name, color] = pickName(reg, info.folder, now, id);
    a = {
      id, name, color, folder: info.folder ?? null, pid: info.pid ?? null, host: info.host ?? null, branch: info.branch ?? null,
      firstSeen: now, lastSeen: now, cursor: Number.isSafeInteger(info.seq) && info.seq >= 0 ? info.seq : 0, endedAt: null,
    };
    // defineProperty: plain assignment with the id "__proto__" would change the prototype, not add an entry
    Object.defineProperty(reg.agents, id, { value: a, writable: true, enumerable: true, configurable: true });
  } else if (!isLive(a)) {
    // a comeback never takes another gone agent's name by continuity: that is for new sessions
    const taken = Object.entries(reg.agents).some(([otherId, other]) => otherId !== id && isLive(other) && other.name === a.name);
    if (taken) [a.name, a.color] = pickName(reg, null, now, id);
  }
  a.lastSeen = now;
  a.endedAt = null;
  if (info.folder) a.folder = info.folder;
  if (info.pid != null) a.pid = info.pid;
  if (info.host) a.host = info.host;
  if (info.branch !== undefined) a.branch = info.branch;
  return a;
}

/**
 * Marks an agent as gone at `now`. An unknown or already ended agent is left as it is, so the
 * first end time is kept.
 * @param {Registry} reg @param {string} id @param {number} now
 */
export function endAgent(reg, id, now) {
  const a = getAgent(reg, id);
  if (a && isLive(a)) a.endedAt = now;
}

/**
 * Which registered agent an MCP server acts for (§4 Identity). Null means "register a new one".
 * 1. the session id, when that agent is registered and live;
 * 2. the live agent with the same pid (on the same host when q.host is given), the most recently
 *    seen one if a registry still holds several;
 * 3. only when no session id is given: the single live agent whose folder is q.folder (two or
 *    more: no guess);
 * 4. null.
 * @param {Registry} reg
 * @param {{ sessionId?: string | null, pid?: number | null, host?: string | null, folder?: string | null }} q
 *   sessionId: CLAUDE_CODE_SESSION_ID; pid: the host process (CLAUDE_PID); host: currentHost();
 *   folder: the agent's working folder
 * @param {number} [now] caps lastSeen times from skewed clocks
 * @returns {string | null}
 */
export function resolveAgentId(reg, q, now = Date.now()) {
  const s = getAgent(reg, q.sessionId);
  if (s && isLive(s)) return /** @type {string} */ (q.sessionId);
  const live = Object.entries(reg.agents).filter(([id, a]) => id !== '' && isLive(a));
  if (Number.isInteger(q.pid) && /** @type {number} */ (q.pid) > 0) {
    const newest = newestFirst(now);
    const [first] = live.filter(([, a]) => a.pid === q.pid && (q.host == null || a.host === q.host)).sort((x, y) => newest(x[1], y[1]));
    if (first) return first[0];
  }
  if (!q.sessionId && q.folder) {
    const here = live.filter(([, a]) => samePath(a.folder, q.folder));
    if (here.length === 1) return here[0][0];
  }
  return null;
}

/** Human-readable author name for texts shown to agents. */
export function nameOf(reg, id) {
  if (id === 'human') return 'the human';
  if (id === 'system') return 'system';
  return getAgent(reg, id)?.name ?? 'an earlier agent';
}
