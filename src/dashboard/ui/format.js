/**
 * Formatting shared by the dashboard UI and the Node tests (no DOM, no clock: callers pass `now`).
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * A span of time, rounded down, at least 1 min: "40 min", "20 h", "3 d".
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  const t = Math.max(0, ms);
  if (t < HOUR) return `${Math.max(1, Math.floor(t / MIN))} min`;
  if (t < DAY) return `${Math.floor(t / HOUR)} h`;
  return `${Math.floor(t / DAY)} d`;
}

/**
 * How long ago: "just now" under a minute (and for times in the future), else "<duration> ago".
 * @param {number} ms
 * @returns {string}
 */
export function timeAgo(ms) {
  return ms < MIN ? 'just now' : `${duration(ms)} ago`;
}

/**
 * @param {number} n
 * @returns {string} "1st", "2nd", "11th"...
 */
export function ordinal(n) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

/**
 * "#21", "#21 and #25", "#21, #25 and #30".
 * @param {number[]} ids
 * @returns {string}
 */
export function joinIds(ids) {
  const tags = ids.map((id) => `#${id}`);
  return tags.length <= 1 ? (tags[0] ?? '') : `${tags.slice(0, -1).join(', ')} and ${tags.at(-1)}`;
}

/**
 * @param {number} n
 * @param {string} word
 * @returns {string} "1 agent", "3 agents"
 */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * A card's meta text (spec section 13 Board table), from the view model's `meta`.
 * @param {object|null} meta
 * @param {number} now
 * @returns {string}
 */
export function metaText(meta, now) {
  if (!meta) return '';
  switch (meta.kind) {
    case 'origin': return meta.suggestedBy ? `suggested by ${meta.suggestedBy}` : 'created by you';
    case 'queue': return `${ordinal(meta.position)} in line`;
    case 'progress': {
      const since = Number.isFinite(meta.lastActivityAt) ? duration(now - meta.lastActivityAt) : '';
      const list = meta.checklist && meta.checklist.total > 0 ? `${meta.checklist.done}/${meta.checklist.total}` : '';
      return [list, since].filter(Boolean).join(' · ');
    }
    case 'waits': return `back to ${meta.backTo} when #${meta.id} closes`;
    case 'done': return Number.isFinite(meta.at) ? timeAgo(now - meta.at) : '';
    default: return '';
  }
}

/**
 * The request to copy into an agent for a Needs-you item (spec section 13 Overview).
 * @param {{kind: string, taskId?: number, ids?: number[], id?: number}} item
 * @returns {string}
 */
export function askLine(item) {
  switch (item.kind) {
    case 'question': return `answer #${item.taskId}: `;
    case 'approve': return `approve ${joinIds(item.ids)}`;
    case 'stalled': return `resume #${item.id}`;
    default: return '';
  }
}
