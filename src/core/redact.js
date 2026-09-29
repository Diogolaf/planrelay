const R = '[REDACTED]';

/**
 * Secrets recognisable by their own shape, replaced whole, in order. Every rule runs in linear time:
 * token rules start with a "not preceded by a token character" lookbehind instead of \b, so a match
 * can start at most once per run of token characters, and every repetition stops at the end of that run.
 */
const TOKENS = [
  // PEM, OpenSSH and PGP private key blocks, also when the END line is missing (the body stops at the next marker).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:(?!-----(?:BEGIN|END) )[\s\S])*(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)?/g,
  // Slack and Discord webhook URLs, whose path is the secret (early: it may start right after a token).
  /\bhttps:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|discord(?:app)?\.com\/api\/webhooks)\/[\w/-]+/g,
  // OpenAI, Anthropic and DeepSeek style keys: sk-proj-/sk-ant-/... (also in a URL path), or sk- and 32+
  // characters with a digit (not after "/", which keeps branch names like feat/sk-ui-... intact).
  /(?<![\w.-])sk-(?:(?:proj|ant|svcacct|admin)-(?=[\w-]{20})|(?<!\/sk-)(?=[\w-]{32})(?=[\w-]*\d))[\w-]+/g,
  // Stripe, GitHub classic, npm, Hugging Face, Groq and Stripe webhook keys: a prefix and a long alphanumeric run.
  /(?<![\w.-])(?:(?:sk|rk|pk)_(?:live|test)_|gh[pousr]_|npm_|hf_|gsk_|whsec_)[A-Za-z0-9]{20,}(?![\w-])/g,
  // GitHub fine-grained, GitLab, Slack and Google OAuth tokens: a prefix and 16+ token characters.
  /(?<![\w.-])(?:github_pat_|gl(?:pat|dt|rt|ptt|oas|cbt|imt|ft|soat)-|xox[abcdeprs][.-]|xapp-|GOCSPX-|ya29\.)(?=[\w.-]{16})[\w-]+(?:\.[\w-]+)*/g,
  // SendGrid API keys.
  /(?<![\w.-])SG\.[\w-]{22}\.[\w-]{43}(?![\w-])/g,
  // AWS access key ids, long-term and temporary.
  /(?<![\w-])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![\w-])/g,
  // Google API keys.
  /(?<![\w-])AIza[\w-]{35}(?![\w-])/g,
  // JSON Web Tokens.
  /(?<![\w-])eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
];

// scheme://user:PASSWORD@host: only the password goes, the rest of the URL stays.
const URL_CREDENTIALS = /\b([a-z][a-z\d+.-]{1,20}:\/\/[^\s:/@?#]*:)[^\s/?#]+@/gi;

// "Authorization: Bearer/Basic/Token X" always; a bare "Bearer X" / "Basic X" only when X is 16+ characters
// with a digit ("the token <hash>" stays). (?![ \t]) stops the gap from backtracking through a run of blanks.
const AUTH_HEADER = /\b(bearer|basic|token)([ \t]+)(?![ \t])(?:(?<=authorization["']?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+)[\w.~+/-]{8,}|(?<!token[ \t]+)(?=[\w.~+/-]*\d)[\w.~+/-]{16,})=*/gi;

// key=value, key: value, "key": "value", --flag=value. Names must contain a sensitive stem, so ordinary
// pairs are never consumed, and a bare value may not itself start with such a pair ("Tokens: API_TOKEN=x"
// leaves API_TOKEN to its own match). Separators and values never cross a newline; bare values stop at
// whitespace, quotes, backticks and ; & , < > ) } so the surrounding structure stays.
const STEM = String.raw`(?=-{0,2}[\w.-]*?(?:secret|token|pass|pwd|key|credential|sig))`;
const NAME = String.raw`(["']?)(?<![\w.-])${STEM}(-{0,2}\w[\w.-]*)\1`;
const SEP = String.raw`([ \t]*(?::(?!:)|=(?![=>~]))[ \t]*)`;
const NEXT_PAIR = String.raw`["']?${STEM}-{0,2}[\w.-]+["']?[ \t]*(?::(?![:/])|=(?![=>~\s]|$))`;
const VALUE = String.raw`(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|(?!${NEXT_PAIR})(["']?)([^\s"'\x60;&,<>)}]+))`;
const ASSIGN = new RegExp(NAME + SEP + VALUE, 'gi');

// NAME=value as in .env files, `export` and `docker -e`: an unquoted value runs to the next whitespace,
// whatever it contains (generated secrets use ( ) & ; , < > too). Quoted values and references go to ASSIGN.
const ENV_ASSIGN = /(?<![\w.$-])([A-Z][A-Z\d_]*)=(?![=>~"'`\s])(?!\$\{|\$[A-Za-z_]\w*(?![^\s`])|%\w+%(?![^\s`]))([^\s`]+)/g;
const envAssignment = (match, name, value) =>
  value === R || !SENSITIVE.test(name) || NOT_SECRET.test(name) ? match : `${name}=${R}`;

/** Key names (camelCase split into words) whose value is a secret. */
const SENSITIVE = /secret|token(?!s|i[sz])|passw(?:or)?d|passphrase|[_.-]pwd$|(?:^|[_.-])pass$|(?:api|access|account|private|encryption|signing|master)[_.-]?key|credential|^sig$|signature/i;
/** Names that contain a sensitive word but hold a setting, not a secret (PASSWORD_MIN_LENGTH, TOKEN_URL). */
const NOT_SECRET = /(?:^|[_.-])(?:min|max|length|len|count|limit|size|ttl|timeout|expiry|expires|lifetime)(?:$|[_.-])|[_.-](?:path|file|dir|name|type|id|url|uri|endpoint|header|prefix)$/i;
const SECRET_SHAPED = /^(?=.*\d)(?=.*[A-Za-z])[\w+/=.~-]{8,}$/;
const LINE_END = /[ \t]*(?:[\r\n]|$)/y;

/**
 * Decides from the shape of an assignment whether to hide its value, and hides it in place:
 * - a quoted value is hidden when the name is SHOUTING_CASE (an environment variable) or the value has no spaces;
 * - a bare value that looks like code (a call, an index, a template) is kept;
 * - tight key=value (.env, CLI flag, query or connection string) is hidden;
 * - after a spaced separator or a colon, the value is hidden when a SHOUTING_CASE name's value ends its
 *   line (`MY_API_KEY: xyz`, but not `case TOKEN_EOF: return null;`) or when the value itself is
 *   secret-shaped: 8+ token characters with a letter and a digit.
 * Empty values, whole references (${…}, $(…), $VAR, %VAR%) and values already redacted are kept (idempotence).
 */
function assignment(match, q, name, sep, dq, sq, open = '', bare, offset, text) {
  const words = name.replace(/([a-z\d])([A-Z])/g, '$1_$2');
  const shouting = /^[A-Z][A-Z\d_]*$/.test(name);
  if (!SENSITIVE.test(words) || NOT_SECRET.test(words)) return match;
  const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
  const value = dq ?? sq ?? bare;
  if (value === '' || value === R || /^(?:\$\{|\$\(|\$[A-Za-z_]\w*$|%\w+%$)/.test(value)) return match;
  let hide;
  if (quote) hide = shouting || !/\s/.test(value);
  else if (/[([{]/.test(value.replaceAll(R, ''))) hide = false; // a call, an index or a template: code
  else if (sep === '=') hide = true;
  else hide = (shouting && endsLine(text, offset + match.length)) || SECRET_SHAPED.test(value);
  return hide ? `${q}${name}${q}${sep}${quote || open}${R}${quote}` : match;
}

function endsLine(text, index) {
  LINE_END.lastIndex = index;
  return LINE_END.test(text);
}

/**
 * Replaces likely secrets with [REDACTED] (§14). Linear time, keeps the surrounding structure, and
 * redact(redact(x)) === redact(x).
 * @template T
 * @param {T} text
 * @returns {T}
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const re of TOKENS) out = out.replace(re, R);
  out = out.replace(URL_CREDENTIALS, `$1${R}@`).replace(AUTH_HEADER, `$1$2${R}`);
  out = out.replace(ENV_ASSIGN, envAssignment);
  return /** @type {any} */ (out.replace(ASSIGN, assignment));
}
