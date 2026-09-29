import { emptyState, newTask, applyEvent } from '../../src/core/reduce.js';
import { emptyRegistry } from '../../src/core/store.js';
import { DEFAULTS } from '../../src/core/config.js';
import { touchAgent } from '../../src/core/agents.js';
import { T0 } from '../helpers.js';

/** A context with agents a1 (Amber, /w/a) and a2 (Jade, /w/b) and the given tasks. */
export function ctxWith({ tasks = [], cfg = DEFAULTS, agentId = 'a1', now = T0 } = {}) {
  const state = emptyState();
  for (const t of tasks) {
    state.tasks[t.id] = newTask(t);
    state.nextId = Math.max(state.nextId, t.id + 1);
  }
  const reg = emptyRegistry();
  touchAgent(reg, { id: 'a1', folder: '/w/a' }, now);
  touchAgent(reg, { id: 'a2', folder: '/w/b' }, now);
  return { state, reg, cfg, agentId, now };
}

/** Applies an op's events the way the store would (stamping seq, at and message ids). */
export function apply(ctx, out) {
  let seq = ctx.state.seq;
  for (const e of out.events) {
    seq += 1;
    const data = e.type === 'message.posted' ? { message: { ...e.data.message, id: `m${seq}`, at: ctx.now } } : e.data;
    applyEvent(ctx.state, { seq, at: ctx.now, type: e.type, actor: e.actor, data });
  }
  return out;
}
