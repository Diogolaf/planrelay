const R = '[REDACTED]';

/** Ordered: whole blocks first, then token formats, then KEY=value assignments. */
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, R],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, R],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R],
  [/\bwhsec_[A-Za-z0-9+/=_-]{16,}/g, R],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, R],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY)[A-Z0-9_]*)\s*[=:]\s*("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/g, `$1=${R}`],
];

/**
 * Replaces likely secrets with [REDACTED] (§14).
 * @template T
 * @param {T} text
 * @returns {T}
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  return /** @type {any} */ (RULES.reduce((out, [re, rep]) => out.replace(/** @type {RegExp} */ (re), /** @type {string} */ (rep)), text));
}
