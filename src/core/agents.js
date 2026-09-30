import os from 'node:os';
import { samePath } from './paths.js';
import { displayName } from './reduce.js';

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
 *   host: string | null, branch: string | null, firstSeen: number, lastSeen: number, cursor?: number,
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
 * The pid of the Claude Code process an agent runs in (§4 Identity), the same for its hooks and
 * its MCP server: CLAUDE_PID when it is a whole number above 0, else `ppid`, this process's parent.
 * Claude Code sets CLAUDE_PID for hooks but not for MCP servers (seen in Claude Code 2.1.247).
 * The fallback assumes Claude Code starts hooks and the MCP server in exec form (`command` plus
 * `args`, as hooks/hooks.json and .mcp.json declare them), with no shell or launcher in between,
 * so the parent is the Claude Code process itself; in a real session, the parent pid of both
 * equalled the hooks' CLAUDE_PID. A launcher in between (a Volta or Scoop shim) gives its own pid
 * instead; resolveAgentId's folder step still finds the session after /clear.
 * Null when neither is usable; a parent of 1 or less (none, or init after the parent exited) is
 * not a session's process.
 * @param {Record<string, string | undefined>} [env] @param {number} [ppid]
 * @returns {number | null}
 */
export function hostPid(env = process.env, ppid = process.ppid) {
  const n = Number(env.CLAUDE_PID);
  if (Number.isInteger(n) && n > 0) return n;
  return Number.isInteger(ppid) && ppid > 1 ? ppid : null;
}

/**
 * The agent with this id: a non-empty string that is an own key of the registry (never a
 * property of Object.prototype, such as "__proto__" or "toString").
 * @param {Registry} reg @param {unknown} id @returns {Agent | undefined}
 */
export function getAgent(reg, id) {
  return typeof id === 'string' && id !== '' && Object.hasOwn(reg.agents, id) ? reg.agents[id] : undefined;
}

/** A board sequence number: a whole number of 0 or more. */
const isSeq = (v) => Number.isSafeInteger(v) && v >= 0;
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
  const fresh = paletteName(held);
  if (fresh) return fresh;
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
  return numberedName(held);
}

/** The first palette name `held` lacks, with its color; undefined when it holds them all. @returns {[string, string] | undefined} */
function paletteName(held) {
  const free = PALETTE.find(([name]) => !held.has(name));
  return free ? [free[0], free[1]] : undefined;
}

/** The first numbered name `held` lacks ("Amber 2", "Jade 2" … "Slate 2", "Amber 3" …), with its palette color. @returns {[string, string]} */
function numberedName(held) {
  for (let n = 2; ; n++) {
    const free = PALETTE.find(([name]) => !held.has(`${name} ${n}`));
    if (free) return [`${free[0]} ${n}`, free[1]];
  }
}

/** A color the dashboard can use: "#" and six hex digits. */
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The palette color for a name: that of its palette name ("Amber" and "Amber 2" get Amber's), else
 * one picked from the name's characters, so the same name always gets the same color.
 * @param {string} name @returns {string}
 */
function colorFor(name) {
  const base = PALETTE.find(([n]) => name === n || name.startsWith(`${n} `));
  if (base) return base[1];
  let sum = 0;
  for (const c of name) sum = (sum + /** @type {number} */ (c.codePointAt(0))) % PALETTE.length;
  return PALETTE[sum][1];
}

/**
 * Repairs the agents of a registry read from disk (store.readRegistry), so every one has a name that
 * displayName accepts and a #rrggbb color. The result depends on the agents alone (their key order,
 * never the clock or the file system):
 * - a usable name is kept, trimmed;
 * - an unusable one (not text, empty, too long) is replaced, in key order, by the first name no
 *   other agent holds, as touchAgent names a new agent that has no folder continuity: a palette
 *   name, then a numbered one, with its color. Repaired names are unique in the registry;
 * - a color that is not #rrggbb becomes the palette color of the name (colorFor).
 * Mutates the agents. @param {Record<string, any>} agents
 */
export function repairIdentities(agents) {
  const list = Object.values(agents);
  const held = new Set(list.map((a) => displayName(a.name)).filter((name) => name !== undefined));
  for (const a of list) {
    const name = displayName(a.name);
    if (name === undefined) {
      [a.name, a.color] = paletteName(held) ?? numberedName(held);
      held.add(a.name);
      continue;
    }
    a.name = name;
    if (!(typeof a.color === 'string' && COLOR.test(a.color))) a.color = colorFor(name);
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
 *   a usable cursor: an agent that comes back is shown what it missed. An existing agent without a
 *   usable cursor (missing, or dropped by the registry reader) gets info.seq when that is usable.
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
      firstSeen: now, lastSeen: now, cursor: isSeq(info.seq) ? info.seq : 0, endedAt: null,
    };
    // defineProperty: plain assignment with the id "__proto__" would change the prototype, not add an entry
    Object.defineProperty(reg.agents, id, { value: a, writable: true, enumerable: true, configurable: true });
  } else if (!isLive(a)) {
    // a comeback never takes another gone agent's name by continuity: that is for new sessions
    const taken = Object.entries(reg.agents).some(([otherId, other]) => otherId !== id && isLive(other) && other.name === a.name);
    if (taken) [a.name, a.color] = pickName(reg, null, now, id);
  }
  if (!isSeq(a.cursor) && isSeq(info.seq)) a.cursor = info.seq;
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
 * 3. when no session id is given, or it names an agent whose session ended: the single live agent
 *    whose folder is q.folder (two or more: no guess). After /clear the server keeps its first
 *    session id, and with a launcher (a Volta or Scoop shim) its pid is the launcher's, so step 2
 *    finds nothing. An unknown session id (its hooks have not run yet) skips this step;
 * 4. null, never the ended agent.
 * @param {Registry} reg
 * @param {{ sessionId?: string | null, pid?: number | null, host?: string | null, folder?: string | null }} q
 *   sessionId: CLAUDE_CODE_SESSION_ID; pid: the host process (hostPid()); host: currentHost();
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
  if ((!q.sessionId || (s && !isLive(s))) && q.folder) {
    const here = live.filter(([, a]) => samePath(a.folder, q.folder));
    if (here.length === 1) return here[0][0];
  }
  return null;
}

/** Human-readable author name for texts shown to agents: always non-empty text, whatever the registry holds. */
export function nameOf(reg, id) {
  if (id === 'human') return 'the human';
  if (id === 'system') return 'system';
  return displayName(getAgent(reg, id)?.name) ?? 'an earlier agent';
}
