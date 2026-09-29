import path from 'node:path';
import { CONFIG_DIR } from '../name.js';
import { readJson } from './fsx.js';

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

/** @param {string} repoRoot @returns {Config} */
export function loadConfig(repoRoot) {
  const raw = readJson(path.join(repoRoot, CONFIG_DIR, 'config.json'), {});
  /** @type {any} */
  const cfg = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = raw[key];
      if (typeof value !== typeof DEFAULTS[key]) continue;
      if (typeof value === 'number' && !(Number.isFinite(value) && value > 0)) continue;
      cfg[key] = value;
    }
  }
  if (!['auto', 'always', 'off'].includes(cfg.locks)) cfg.locks = DEFAULTS.locks;
  return cfg;
}

/** Project rules the skill reads (§7, §11). */
export function rulesPath(repoRoot) {
  return path.join(repoRoot, CONFIG_DIR, 'rules.md');
}
