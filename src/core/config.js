import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../name.js';

/** §7 — every option has a default, so the config file is optional. */
export const DEFAULTS = Object.freeze({
  agentTasksNeedApproval: true,
  locks: /** @type {'auto' | 'always' | 'off'} */ ('auto'),
  lockMinutes: 30,
  claimTimeoutHours: 24,
  idleMinutes: 15,
  maxPings: 8,
});

/** @typedef {typeof DEFAULTS} Config */
/** @typedef {{ config: Config, problems: string[] }} ConfigResult */

const FILE = `${CONFIG_DIR}/config.json`;
const LOCKS = ['auto', 'always', 'off'];
/** §7 ranges; values outside are clamped to the nearest limit. */
const RANGES = {
  lockMinutes: [1, 10080],
  idleMinutes: [1, 1440],
  claimTimeoutHours: [1, 8760],
  maxPings: [1, 50],
};
/** Problems go into the session brief, so a file full of junk cannot flood it. */
const MAX_PROBLEMS = 10;

/** Text of a config file: UTF-8 with or without a BOM, or UTF-16 LE/BE with a BOM. */
function decode(input) {
  if (typeof input === 'string') return input.replace(/^﻿/, '');
  if (!(input instanceof Uint8Array)) return String(input);
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2))); // a copy, even length
    return le.swap16().toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

/**
 * Node's parse message without file content: V8's "Unexpected token" form quotes a piece of the
 * input, so only the token is kept (as a code point when it is not printable ASCII).
 */
function parseMessage(err) {
  let msg = String(/** @type {any} */ (err)?.message ?? err);
  const tok = /^Unexpected token '([\s\S]+?)', [\s\S]* is not valid JSON$/.exec(msg);
  if (tok) {
    const cp = /** @type {number} */ (tok[1].codePointAt(0));
    msg = /^[\x21-\x7e]$/.test(tok[1])
      ? `Unexpected token '${tok[1]}'`
      : `Unexpected character U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return msg.split('"')[0].replace(/[^\x20-\x7e]/g, '?').trim().slice(0, 120) || 'parse error';
}

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Checks one known option; returns the value to use and at most one problem. */
function check(key, value) {
  const fallback = DEFAULTS[key];
  const using = `using ${JSON.stringify(fallback)}`;
  if (key === 'agentTasksNeedApproval') {
    return typeof value === 'boolean' ? { value } : { value: fallback, problem: `${key} must be true or false; ${using}` };
  }
  if (key === 'locks') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : null;
    return v !== null && LOCKS.includes(v)
      ? { value: v }
      : { value: fallback, problem: `${key} must be "auto", "always" or "off"; ${using}` };
  }
  const [min, max] = RANGES[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return { value: fallback, problem: `${key} must be a number; ${using}` };
  if (key === 'maxPings' && !Number.isInteger(value)) return { value: fallback, problem: `${key} must be a whole number; ${using}` };
  if (value < min) return { value: min, problem: `${key} ${value} is below ${min}; using ${min}` };
  if (value > max) return { value: max, problem: `${key} ${value} is above ${max}; using ${max}` };
  return { value };
}

/**
 * Parses the text (or raw bytes) of `.agentboard/config.json`. Pure and never throws: every
 * problem falls back per key (§7) and is described in one short line without file content.
 * @param {string | Uint8Array} input @returns {ConfigResult}
 */
export function parseConfig(input) {
  /** @type {string[]} */
  const problems = [];
  /** @type {any} */
  const config = { ...DEFAULTS };
  let raw;
  try {
    raw = JSON.parse(decode(input));
  } catch (err) {
    return { config: DEFAULTS, problems: [`not valid JSON (${parseMessage(err)}); using defaults`] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: DEFAULTS, problems: [`must be a JSON object, not ${kindOf(raw)}; using defaults`] };
  }
  for (const key of Object.keys(raw)) { // own keys only; a "__proto__" key is just an unknown key
    if (!Object.hasOwn(DEFAULTS, key)) {
      problems.push(`unknown option ${JSON.stringify(key.slice(0, 40))}`);
      continue;
    }
    const { value, problem } = check(key, raw[key]);
    config[key] = value;
    if (problem) problems.push(problem);
  }
  if (problems.length > MAX_PROBLEMS) {
    const more = problems.length - MAX_PROBLEMS;
    problems.splice(MAX_PROBLEMS, more, `and ${more} more problem${more === 1 ? '' : 's'}`);
  }
  return { config: Object.freeze(config), problems };
}

/**
 * Reads the config of a checkout (the store passes the main worktree, §7). Never throws:
 * a missing file means defaults; any other read error means defaults plus one problem.
 * @param {string} root @returns {ConfigResult}
 */
export function readConfig(root) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(root, CONFIG_DIR, 'config.json'));
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'ENOENT') return { config: DEFAULTS, problems: [] };
    return { config: DEFAULTS, problems: [`could not read ${FILE} (${code ?? 'error'})`] };
  }
  return parseConfig(bytes);
}

/** @param {string} root @returns {Config} */
export function loadConfig(root) {
  return readConfig(root).config;
}

/** Project rules the skill reads (§7, §11). */
export function rulesPath(repoRoot) {
  return path.join(repoRoot, CONFIG_DIR, 'rules.md');
}
