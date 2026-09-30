import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import {
  touchAgent, endAgent, statusOf, resolveAgentId, activeCount, nameOf, getAgent, currentHost, hostPid, PALETTE,
} from '../../src/core/agents.js';
import { T0, MIN, HOUR } from '../helpers.js';

const colorOf = (name) => PALETTE.find(([n]) => n === name)[1];
const HOST = 'linux:box-a:';

test('new agents get the first palette name no agent has held, with its color', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1', folder: '/w/a', pid: 10 }, T0);
  const b = touchAgent(reg, { id: 's2', folder: '/w/b', pid: 11 }, T0);
  assert.equal(a.name, 'Amber');
  assert.equal(a.color, PALETTE[0][1]);
  assert.equal(b.name, 'Jade');
  endAgent(reg, 's1', T0 + 1);
  // Amber's holder is gone but still remembered: a session elsewhere gets a name never held
  assert.equal(touchAgent(reg, { id: 's3' }, T0 + 2).name, 'Cobalt');
});

test('the palette is frozen', () => {
  assert.ok(Object.isFrozen(PALETTE));
  assert.ok(PALETTE.every((entry) => Object.isFrozen(entry)));
  assert.equal(new Set(PALETTE.map(([name]) => name)).size, PALETTE.length);
});

test('names: continuity in the folder of a gone agent, the most recently seen one', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a' }, T0);
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + MIN);
  endAgent(reg, 's1', T0 + 2 * MIN);
  endAgent(reg, 's2', T0 + 2 * MIN);
  const next = touchAgent(reg, { id: 's3', folder: '/w/a' }, T0 + 3 * MIN);
  assert.equal(next.name, 'Jade');
  assert.equal(next.color, colorOf('Jade'));
  // the folder is compared as a path, and another folder gets no continuity
  endAgent(reg, 's3', T0 + 4 * MIN);
  assert.equal(touchAgent(reg, { id: 's4', folder: '/w/a/' }, T0 + 5 * MIN).name, 'Jade');
  assert.equal(touchAgent(reg, { id: 's5', folder: '/w/other' }, T0 + 6 * MIN).name, 'Cobalt');
});

test('names: no continuity when a live agent already has that name', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a' }, T0);
  endAgent(reg, 's1', T0 + MIN);
  assert.equal(touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + 2 * MIN).name, 'Amber'); // continuity
  // s1 is still the most recently seen gone agent in /w/a, but s2 (live) holds Amber
  assert.equal(touchAgent(reg, { id: 's3', folder: '/w/a' }, T0 + 3 * MIN).name, 'Jade');
});

test('names: when every palette name was held, the one whose holder ended longest ago', () => {
  const reg = emptyRegistry();
  for (let i = 0; i < PALETTE.length; i++) touchAgent(reg, { id: `s${i}` }, T0);
  endAgent(reg, 's5', T0 + 5 * MIN); // Moss
  endAgent(reg, 's2', T0 + 3 * MIN); // Cobalt
  const next = touchAgent(reg, { id: 'new' }, T0 + 6 * MIN);
  assert.equal(next.name, 'Cobalt');
  assert.equal(next.color, colorOf('Cobalt'));
  assert.equal(touchAgent(reg, { id: 'new2' }, T0 + 7 * MIN).name, 'Moss');
});

test('names: numbered when every palette name is live ("Amber 2", then "Jade 2")', () => {
  const reg = emptyRegistry();
  for (let i = 0; i < PALETTE.length; i++) touchAgent(reg, { id: `s${i}` }, T0);
  const extra = touchAgent(reg, { id: 'extra' }, T0);
  assert.equal(extra.name, 'Amber 2');
  assert.equal(extra.color, colorOf('Amber'));
  assert.equal(touchAgent(reg, { id: 'extra2' }, T0).name, 'Jade 2');
  endAgent(reg, 'extra', T0 + MIN); // "Amber 2" is still remembered, so it is not handed out again yet
  assert.equal(touchAgent(reg, { id: 'extra3' }, T0 + 2 * MIN).name, 'Cobalt 2');
  const names = Object.values(reg.agents).filter((a) => a.endedAt == null).map((a) => a.name);
  assert.equal(new Set(names).size, names.length);
});

test('touch refreshes lastSeen, revives an ended agent and keeps its name', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w' }, T0);
  endAgent(reg, 's1', T0 + MIN);
  const again = touchAgent(reg, { id: 's1', pid: 42 }, T0 + 2 * MIN);
  assert.equal(again.endedAt, null);
  assert.equal(again.lastSeen, T0 + 2 * MIN);
  assert.equal(again.pid, 42);
  assert.equal(again.folder, '/w');
  assert.equal(again.name, 'Amber');
});

test('a new agent starts its cursor at the board sequence number it is given; a touch never moves a cursor', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1', seq: 42 }, T0);
  assert.equal(a.cursor, 42);
  assert.equal(touchAgent(reg, { id: 's2', seq: 0 }, T0).cursor, 0);
  const unusable = [undefined, null, -1, 1.5, '42', Number.NaN, Number.MAX_SAFE_INTEGER + 2, T0 + 0.5];
  unusable.forEach((seq, i) => assert.equal(touchAgent(reg, { id: `s${i + 3}`, seq }, T0).cursor, 0, String(seq)));
  a.prevCursor = 40;
  touchAgent(reg, { id: 's1', seq: 99 }, T0 + MIN);
  assert.deepEqual([a.cursor, a.prevCursor], [42, 40]);
  // a session that comes back keeps its cursor, so it is shown what it missed
  endAgent(reg, 's1', T0 + 2 * MIN);
  touchAgent(reg, { id: 's1', seq: 120 }, T0 + 3 * MIN);
  assert.deepEqual([a.endedAt, a.cursor, a.prevCursor], [null, 42, 40]);
});

test('a touch gives an existing agent without a usable cursor the sequence number it is given', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1', seq: 5 }, T0);
  delete a.cursor; // as the registry reader leaves an agent whose cursor was unusable
  touchAgent(reg, { id: 's1', seq: 'soon' }, T0 + MIN); // nothing usable to set
  assert.equal(Object.hasOwn(a, 'cursor'), false);
  touchAgent(reg, { id: 's1', seq: 30 }, T0 + 2 * MIN);
  assert.equal(a.cursor, 30);
  touchAgent(reg, { id: 's1', seq: 31 }, T0 + 3 * MIN); // a usable cursor never moves
  assert.equal(a.cursor, 30);
  for (const bad of [-1, 2.5, '7', null]) {
    a.cursor = bad;
    touchAgent(reg, { id: 's1', seq: 40 }, T0 + 4 * MIN);
    assert.equal(a.cursor, 40, String(bad));
  }
});

test('an agent that comes back is renamed when a live agent took its name meanwhile', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a' }, T0);
  endAgent(reg, 's1', T0 + MIN);
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + 2 * MIN); // takes Amber by continuity
  const back = touchAgent(reg, { id: 's1', folder: '/w/a' }, T0 + 3 * MIN);
  assert.equal(back.name, 'Jade');
  assert.equal(back.color, colorOf('Jade'));
  assert.equal(reg.agents.s2.name, 'Amber');
});

test('one live agent per host process: a touch with a pid and host ends the others', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a', pid: 500, host: HOST }, T0);
  touchAgent(reg, { id: 'other', folder: '/w/b', pid: 501, host: HOST }, T0);
  // /clear: a new session in the same host process
  const next = touchAgent(reg, { id: 's2', folder: '/w/a', pid: 500, host: HOST }, T0 + MIN);
  assert.equal(reg.agents.s1.endedAt, T0 + MIN);
  assert.equal(reg.agents.other.endedAt, null);
  assert.equal(next.name, 'Amber'); // s1 ended first, so its name carries over
  // touching itself again ends nothing
  touchAgent(reg, { id: 's2', pid: 500, host: HOST }, T0 + 2 * MIN);
  assert.equal(reg.agents.s2.endedAt, null);
  // the same pid on another host, or without a host, is another process
  touchAgent(reg, { id: 'wsl', pid: 500, host: 'linux:box-a:Ubuntu' }, T0 + 3 * MIN);
  touchAgent(reg, { id: 'nohost', pid: 500 }, T0 + 3 * MIN);
  assert.equal(reg.agents.s2.endedAt, null);
  assert.equal(reg.agents.wsl.endedAt, null);
  // a pid that is not a whole number above 0 ends nothing
  touchAgent(reg, { id: 'zero', pid: 0, host: HOST }, T0 + 4 * MIN);
  touchAgent(reg, { id: 'zero2', pid: 0, host: HOST }, T0 + 4 * MIN);
  assert.equal(reg.agents.zero.endedAt, null);
});

test('touch records the host and keeps it when none is given', () => {
  const reg = emptyRegistry();
  assert.equal(touchAgent(reg, { id: 's1' }, T0).host, null);
  assert.equal(touchAgent(reg, { id: 's1', host: HOST }, T0).host, HOST);
  assert.equal(touchAgent(reg, { id: 's1' }, T0).host, HOST);
});

test('currentHost: platform, lower-case machine name and WSL distribution', () => {
  const host = currentHost({ WSL_DISTRO_NAME: 'Ubuntu-Test' });
  assert.ok(host.startsWith(`${process.platform}:`));
  assert.ok(host.endsWith(':Ubuntu-Test'));
  assert.equal(host.split(':')[1], host.split(':')[1].toLowerCase());
  assert.ok(currentHost({}).endsWith(':'));
  assert.equal(currentHost({}), currentHost({}));
});

test('hostPid: CLAUDE_PID when usable, else the parent process (Claude Code gives MCP servers no CLAUDE_PID)', () => {
  assert.equal(hostPid({ CLAUDE_PID: '4242' }, 77), 4242);
  for (const bad of [undefined, '', 'abc', '0', '-5', '1.5']) assert.equal(hostPid({ CLAUDE_PID: bad }, 77), 77, String(bad));
  // no usable parent either: no parent (0) or init after the parent exited (1)
  for (const ppid of [0, 1, NaN, 2.5]) assert.equal(hostPid({}, ppid), null, String(ppid));
  assert.equal(hostPid({}), process.ppid);
});

test('status: active, idle, gone', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1' }, T0);
  assert.equal(statusOf(a, T0 + 14 * MIN, DEFAULTS), 'active');
  assert.equal(statusOf(a, T0 + 16 * MIN, DEFAULTS), 'idle');
  endAgent(reg, 's1', T0);
  assert.equal(statusOf(a, T0, DEFAULTS), 'gone');
  assert.equal(statusOf(undefined, T0, DEFAULTS), 'gone');
  touchAgent(reg, { id: 's2' }, T0);
  touchAgent(reg, { id: 's3' }, T0 - 20 * MIN);
  assert.equal(activeCount(reg, T0, DEFAULTS), 1);
});

test('clock skew: a lastSeen far ahead is idle, and never counts as later than now', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1' }, T0);
  a.lastSeen = T0 + 5 * MIN;
  assert.equal(statusOf(a, T0, DEFAULTS), 'active'); // a little ahead: another host's clock
  a.lastSeen = T0 + 16 * MIN;
  assert.equal(statusOf(a, T0, DEFAULTS), 'idle');
  a.lastSeen = Number.NaN;
  assert.equal(statusOf(a, T0, DEFAULTS), 'idle');
  // recency: 'now' registered first, 'ahead' has a time in the future; both count as now, so the tie keeps order
  const r2 = emptyRegistry();
  touchAgent(r2, { id: 'now', pid: 7 }, T0);
  touchAgent(r2, { id: 'ahead', pid: 7 }, T0 + 30 * 24 * HOUR);
  assert.equal(resolveAgentId(r2, { pid: 7 }, T0), 'now');
  assert.equal(resolveAgentId(r2, { pid: 7 }, T0 + 31 * 24 * HOUR), 'ahead');
});

test('an endedAt of 0 still means ended', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1', folder: '/w/a', pid: 9 }, T0);
  a.endedAt = 0;
  assert.equal(statusOf(a, T0, DEFAULTS), 'gone');
  assert.equal(activeCount(reg, T0, DEFAULTS), 0);
  assert.equal(resolveAgentId(reg, { sessionId: 's1' }), null);
  assert.equal(resolveAgentId(reg, { pid: 9 }), null);
  assert.equal(resolveAgentId(reg, { folder: '/w/a' }), null);
  endAgent(reg, 's1', T0 + MIN);
  assert.equal(a.endedAt, 0); // the first end time is kept
  assert.equal(touchAgent(reg, { id: 'next', folder: '/w/a' }, T0 + MIN).name, 'Amber'); // gone: continuity applies
});

test('MCP identity: session id, then pid, then folder (§4)', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', pid: 100, folder: '/w/a' }, T0);
  touchAgent(reg, { id: 's2', pid: 200, folder: '/w/b' }, T0 + 1);
  assert.equal(resolveAgentId(reg, { sessionId: 's2', pid: 100, folder: '/w/a' }), 's2');
  assert.equal(resolveAgentId(reg, { sessionId: 'unknown', pid: 100 }), 's1');
  assert.equal(resolveAgentId(reg, { folder: '/w/b' }), 's2');
  endAgent(reg, 's2', T0 + 2);
  assert.equal(resolveAgentId(reg, { sessionId: 's2', folder: '/w/b' }), null);
});

test('MCP identity: without a session id, the folder step decides, and never guesses', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1', folder: '/w/a' }, T0);
  assert.equal(resolveAgentId(reg, { folder: '/w/a' }), 's1');
  assert.equal(resolveAgentId(reg, { sessionId: '', folder: '/w/a' }), 's1'); // empty: no session id
  assert.equal(resolveAgentId(reg, { sessionId: 'new-session', folder: '/w/a' }), null);
  touchAgent(reg, { id: 's2', folder: '/w/a' }, T0 + MIN);
  assert.equal(resolveAgentId(reg, { folder: '/w/a' }), null); // two live agents there: no guess
  endAgent(reg, 's1', T0 + 2 * MIN);
  assert.equal(resolveAgentId(reg, { folder: '/w/a' }), 's2');
});

test('MCP identity: a session id whose agent ended (/clear) falls back to the folder, never to the ended agent', () => {
  const reg = emptyRegistry();
  // the server keeps its first session id; its pid (555) is a launcher's, not the host process's (100)
  const server = { sessionId: 's1', pid: 555, folder: '/w/a' };
  touchAgent(reg, { id: 's1', pid: 100, folder: '/w/a' }, T0);
  endAgent(reg, 's1', T0 + MIN);
  assert.equal(resolveAgentId(reg, server), null); // the new session's hooks have not run yet
  touchAgent(reg, { id: 's2', pid: 100, folder: '/w/a' }, T0 + MIN);
  touchAgent(reg, { id: 'elsewhere', pid: 300, folder: '/w/b' }, T0 + MIN);
  assert.equal(resolveAgentId(reg, server), 's2');
  touchAgent(reg, { id: 's3', pid: 400, folder: '/w/a' }, T0 + 2 * MIN);
  assert.equal(resolveAgentId(reg, server), null); // two live agents there: no guess
  assert.equal(reg.agents.s1.endedAt, T0 + MIN);
});

test('MCP identity: the most recently seen of two live agents sharing a pid, on the given host', () => {
  const reg = emptyRegistry();
  // registered without a host, so neither ends the other (an older registry)
  touchAgent(reg, { id: 'old', pid: 7 }, T0);
  touchAgent(reg, { id: 'recent', pid: 7 }, T0 + MIN);
  assert.equal(resolveAgentId(reg, { pid: 7 }), 'recent');
  reg.agents.old.lastSeen = T0 + 2 * MIN;
  assert.equal(resolveAgentId(reg, { pid: 7 }), 'old');
  const r2 = emptyRegistry();
  touchAgent(r2, { id: 'win', pid: 7, host: HOST }, T0);
  touchAgent(r2, { id: 'wsl', pid: 7, host: 'linux:box-a:Ubuntu' }, T0 + MIN);
  assert.equal(resolveAgentId(r2, { pid: 7, host: HOST }), 'win');
  assert.equal(resolveAgentId(r2, { pid: 7, host: 'darwin:box-b:' }), null);
  assert.equal(resolveAgentId(r2, { pid: 7 }), 'wsl');
  assert.equal(resolveAgentId(r2, { pid: 0 }), null);
});

test('nameOf', () => {
  const reg = emptyRegistry();
  touchAgent(reg, { id: 's1' }, T0);
  assert.equal(nameOf(reg, 's1'), 'Amber');
  assert.equal(nameOf(reg, 'human'), 'the human');
  assert.equal(nameOf(reg, 'system'), 'system');
  assert.equal(nameOf(reg, 'gone-long-ago'), 'an earlier agent');
});

test('nameOf always returns usable text, even from a hand-edited registry', () => {
  const reg = emptyRegistry();
  const a = touchAgent(reg, { id: 's1' }, T0);
  for (const bad of [{ first: 'Amber' }, '', '   ', 7, null, 'A'.repeat(61)]) {
    /** @type {any} */ (a).name = bad;
    assert.equal(nameOf(reg, 's1'), 'an earlier agent', JSON.stringify(bad));
  }
  a.name = '  Amber ';
  assert.equal(nameOf(reg, 's1'), 'Amber');
});

test('empty ids are refused', () => {
  const reg = emptyRegistry();
  assert.throws(() => touchAgent(reg, { id: '' }, T0), TypeError);
  assert.deepEqual(reg.agents, {});
  reg.agents[''] = { id: '', name: 'Amber', color: PALETTE[0][1], endedAt: null, lastSeen: T0 };
  assert.equal(getAgent(reg, ''), undefined);
  assert.equal(resolveAgentId(reg, { sessionId: '' }), null);
});

test('getAgent and ids like __proto__ or toString never reach Object.prototype', () => {
  const reg = emptyRegistry();
  assert.equal(getAgent(reg, '__proto__'), undefined);
  assert.equal(getAgent(reg, 'toString'), undefined);
  assert.equal(getAgent(reg, 'constructor'), undefined);
  assert.equal(getAgent(reg, 42), undefined);
  assert.equal(getAgent(reg, null), undefined);
  assert.equal(resolveAgentId(reg, { sessionId: '__proto__' }), null);
  assert.equal(resolveAgentId(reg, { sessionId: 'toString' }), null);
  assert.equal(resolveAgentId(reg, { sessionId: 42 }), null);
  assert.equal(nameOf(reg, '__proto__'), 'an earlier agent');
  assert.equal(nameOf(reg, 'constructor'), 'an earlier agent');
  endAgent(reg, '__proto__', T0);
  assert.equal(Object.getPrototypeOf(reg.agents), Object.prototype);
  assert.throws(() => touchAgent(reg, { id: 7 }, T0), TypeError);
  assert.throws(() => touchAgent(reg, {}, T0), TypeError);
  const a = touchAgent(reg, { id: '__proto__' }, T0);
  assert.equal(Object.getPrototypeOf(reg.agents), Object.prototype);
  assert.equal(Object.hasOwn(reg.agents, '__proto__'), true);
  assert.equal(a.id, '__proto__');
  assert.equal(getAgent(reg, '__proto__'), a);
  assert.equal(getAgent(reg, 'toString'), undefined);
  assert.equal(resolveAgentId(reg, { sessionId: '__proto__' }), '__proto__');
  assert.equal(nameOf(reg, '__proto__'), 'Amber');
});
