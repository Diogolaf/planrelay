import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/core/redact.js';

// Every fake secret here is invented and assembled at runtime from pieces: the source never holds a literal one.
const R = '[REDACTED]';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const B64 = ALNUM + '+/';
const B64URL = ALNUM + '_-';
const HEX = '0123456789abcdef';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DJANGO = 'abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*(-_=+)';

/** Deterministic pseudo-random text (fixed seed), so every run sees the same fakes. */
let seed = 12345;
function rnd(n, alphabet = ALNUM) {
  let s = '';
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    s += alphabet[(seed >>> 16) % alphabet.length];
  }
  return s;
}
const jwtPart = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

const fakes = {
  stripe: 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0',
  anthropicStyle: 'sk-' + 'ant-' + 'x'.repeat(30),
  github: 'gh' + 'p_' + 'A'.repeat(36),
  githubPat: 'github' + '_pat_' + 'B'.repeat(40),
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  google: 'AI' + 'za' + 'C'.repeat(35),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'c2lnbmF0dXJlLXNpZ25hdHVyZQ',
  webhook: 'wh' + 'sec_' + 'D'.repeat(24),
  slack: 'xo' + 'xb-' + '1234567890-abcdefghij',
};

test('known token formats are replaced', () => {
  for (const [kind, secret] of Object.entries(fakes)) {
    assert.equal(redact(`before ${secret} after`), 'before [REDACTED] after', kind);
  }
});

test('private key blocks are replaced whole', () => {
  const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIBVQIBADANBgkq\n-----END ' + 'PRIVATE KEY-----';
  assert.equal(redact(`key:\n${pem}\nend`), 'key:\n[REDACTED]\nend');
});

test('KEY=value lines with sensitive names keep the name and hide the value', () => {
  assert.equal(redact('DB_PASSWORD=hunter2'), 'DB_PASSWORD=[REDACTED]');
  assert.equal(redact('export STRIPE_SECRET="abc def"'), 'export STRIPE_SECRET="[REDACTED]"');
  assert.equal(redact('MY_API_KEY: xyz'), 'MY_API_KEY: [REDACTED]');
});

test('ordinary text is untouched and redaction is idempotent', () => {
  const prose = 'Use the token from the settings page. #14 Filter by prep time, 30 min.';
  assert.equal(redact(prose), prose);
  const once = redact(`X_TOKEN=abc ${fakes.github}`);
  assert.equal(redact(once), once);
});

test('non-strings pass through', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(null), null);
});

// [label, text before, secret, text after]: redact(before + secret + after) must be before + [REDACTED] + after.
const token = (label, secret) => [label, 'before ', secret, ' after'];
const SECRETS = [
  token('OpenAI sk-proj- key with _ and -', 'sk-' + 'proj-' + rnd(40, B64URL) + '_' + rnd(60, B64URL) + '-' + rnd(50, B64URL)),
  token('OpenAI legacy sk- key', 'sk-' + rnd(24) + '4' + rnd(23)),
  token('OpenAI service account key', 'sk-' + 'svcacct-' + rnd(80, B64URL)),
  ['sk-proj- key in a URL path', 'https://api.example.com/v1/', 'sk-' + 'proj-' + rnd(40, B64URL), '/models'],
  token('Anthropic api03 key', 'sk-' + 'ant-' + 'api03-' + rnd(93, B64URL) + 'AA'),
  token('Anthropic admin key', 'sk-' + 'ant-' + 'admin01-' + rnd(93, B64URL) + 'AA'),
  token('GitHub classic token', 'gh' + 'p_' + rnd(36)),
  token('GitHub fine-grained token', 'github' + '_pat_' + rnd(22) + '_' + rnd(59)),
  token('GitLab personal token', 'gl' + 'pat-' + rnd(20, B64URL)),
  token('GitLab routable token', 'gl' + 'pat-' + rnd(27, B64URL) + '.01.' + rnd(9, HEX)),
  token('GitLab deploy token', 'gl' + 'dt-' + rnd(20, B64URL)),
  token('GitLab runner token', 'gl' + 'rt-' + rnd(20, B64URL)),
  token('npm token', 'np' + 'm_' + rnd(36)),
  token('Hugging Face token', 'h' + 'f_' + rnd(34)),
  token('Groq key', 'gs' + 'k_' + rnd(52)),
  token('Slack bot token', 'xo' + 'xb-' + '1234567890123-1234567890123-' + rnd(24)),
  token('Slack refresh token', 'xo' + 'xe-1-' + rnd(140)),
  token('Slack app-level token', 'xa' + 'pp-1-A' + rnd(10) + '-1234567890123-' + rnd(64, HEX)),
  token('Slack webhook URL', 'https://hooks.' + 'slack.com/services/T' + rnd(8, BASE32) + '/B' + rnd(10, BASE32) + '/' + rnd(24)),
  token('Discord webhook URL', 'https://discord.com/api/' + 'webhooks/' + '123456789012345678/' + rnd(68, B64URL)),
  token('AWS access key id', 'AK' + 'IA' + rnd(16, BASE32)),
  token('AWS temporary access key id', 'AS' + 'IA' + rnd(16, BASE32)),
  ['AWS secret key, lowercase ini', 'aws_secret_access_key = ', 'Wx7' + rnd(37, B64), ''],
  ['AWS secret key, env', 'AWS_SECRET_ACCESS_KEY=', rnd(40, B64), ''],
  token('Google API key ending in -', 'AI' + 'za' + rnd(34, B64URL) + '-'),
  token('Google API key', 'AI' + 'za' + rnd(35)),
  token('Google OAuth client secret', 'GOC' + 'SPX-' + rnd(28, B64URL)),
  token('Google OAuth access token', 'ya' + '29.' + rnd(150, B64URL)),
  token('Stripe secret key', 'sk_' + 'live_' + rnd(99)),
  token('Stripe restricted key', 'rk_' + 'live_' + rnd(99)),
  token('Stripe webhook secret', 'wh' + 'sec_' + rnd(32)),
  token('SendGrid key', 'S' + 'G.' + rnd(22, B64URL) + '.' + rnd(43, B64URL)),
  token('JSON Web Token', jwtPart({ alg: 'HS256', typ: 'JWT' }) + '.' + jwtPart({ sub: 'task-14', board: 'demo' }) + '.' + rnd(43, B64URL)),
  token('PKCS#8 private key', '-----BEGIN ' + 'PRIVATE KEY-----\n' + rnd(64, B64) + '\n' + rnd(64, B64) + '\n-----END ' + 'PRIVATE KEY-----'),
  token('OpenSSH private key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + rnd(70, B64) + '\n-----END ' + 'OPENSSH PRIVATE KEY-----'),
  token('PGP private key block', '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----\n\n' + rnd(64, B64) + '\n-----END ' + 'PGP PRIVATE KEY BLOCK-----'),
  ['private key without END line', 'here is the key:\n', '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIEow' + rnd(64, B64) + '\n' + 'Q' + rnd(40, B64), ''],
  ['service account JSON', '{"type": "service_account", "private_key_id": "' + rnd(40, HEX) + '", "private_key": "',
    '-----BEGIN ' + 'PRIVATE KEY-----\\n' + 'MIIEv' + rnd(60, B64) + '\\n-----END ' + 'PRIVATE KEY-----\\n', '", "client_email": "bot@example-proj.iam.example.com"}'],
  ['JSON client_secret', '{"client_id": "123.apps.example", "client_secret": "', 'Sx9' + rnd(20), '"}'],
  ['JSON password', '{"user": "admin", "password": "', 'Pw7' + rnd(10), '"}'],
  ['postgres URL in an env line', 'DATABASE_URL=postgres://' + 'app_user:', 'Pq8' + rnd(12), '@db.example.internal:5432/app'],
  ['postgres URL in prose', 'connect with postgres://' + 'app_user:', 'Pq8' + rnd(12), '@db.example.internal:5432/app'],
  ['mongodb+srv URL', 'mongodb+srv://' + 'admin:', 'Mg5' + rnd(12), '@cluster0.example.net/db'],
  ['redis URL with empty user', 'redis://' + ':', 'Rd4' + rnd(12), '@cache.example:6379'],
  ['https URL with basic credentials', 'git clone https://' + 'bot:', 'Gt3' + rnd(20), '@git.example.com/org/repo.git'],
  ['Authorization: Bearer', 'curl -H "Authorization: Bearer ', 'Br2' + rnd(30), '" https://api.example.com'],
  ['Authorization: Basic', 'Authorization: Basic ', 'QmFz' + rnd(20, B64) + '==', ''],
  ['lowercase authorization: bearer', 'authorization: bearer ', 'Br2' + rnd(30), ''],
  ['Authorization: Token', 'Authorization: Token ', rnd(40, HEX), ''],
  ['x-api-key header', 'curl -H "x-api-key: ', 'Xk1' + rnd(30), '"'],
  ['lowercase .env password', 'db_password=', 'hunter2', ''],
  ['lowercase .env api_key', 'api_key=', 'Ak9' + rnd(20), ''],
  ['YAML password', 'database:\n  password: ', 'Yp6' + rnd(10), ''],
  ['DB_PASS', 'DB_PASS=', 'Dp5' + rnd(10), ''],
  ['SMTP_PASS', 'SMTP_PASS=', 'Sm5' + rnd(10), ''],
  ['Django-style key with ( ) & in an unquoted .env line', 'SECRET_KEY=',
    'django-' + 'insecure-' + 'Dj4' + rnd(12, DJANGO) + '(' + rnd(12, DJANGO) + ')&' + rnd(12, DJANGO), '\nDEBUG=0'],
  ['.env password with & , ;', 'DB_PASSWORD=', 'Xy9' + '&abc,def;ghi2', ''],
  ['.env password with )', 'DB_PASSWORD=', 'Xy9' + ')tail-' + 'secret-42', ''],
  ['.env password starting with $', 'DB_PASSWORD=', '$ec' + 'ret123!x', ''],
  ['PRIVATE_KEY with 0x value', 'PRIVATE_KEY=', '0x' + rnd(64, HEX), ''],
  ['api_key query parameter', 'https://api.example.com/v1/x?api_key=', 'Qk3' + rnd(20), '&page=2'],
  ['access_token query parameter', 'https://graph.example.com/me?access_token=', 'Qa3' + rnd(40), ''],
  ['S3 presigned URL signature', 'https://bucket.s3.example.com/f.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=', rnd(64, HEX), ''],
  ['SAS URL signature', 'https://acct.blob.example.net/c/f.txt?sv=2022-11-02&sig=', rnd(40) + '%3D', '&se=2026-01-01'],
  ['SAS signature starting with an escape', 'https://acct.blob.example.net/c/b?sv=2022-11-02&sig=', '%2B' + rnd(20) + '%3D', '&se=2026-01-01'],
  ['AccountKey in a connection string', 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=', 'Az1' + rnd(85, B64) + '==', ';EndpointSuffix=core.example.net'],
  ['Password in a connection string', 'Server=db;Database=app;User Id=sa;Password=', 'Ss1' + rnd(10), ';'],
  ['PASSWORD with an unterminated quote', 'DB_PASSWORD="', 'Uq1' + rnd(10), ''],
  ['--password= flag', 'mysql -u root --password=', 'Mf1' + rnd(10), ' app'],
  ['PowerShell env assignment', '$env:OPENAI_API_KEY = "', 'Pe1' + rnd(20), '"'],
];

for (const [label, before, secret, after] of SECRETS) {
  test(`hides ${label}`, () => {
    const out = redact(before + secret + after);
    assert.equal(out, before + R + after);
    assert.equal(redact(out), out);
  });
}

// Ordinary board text that must survive unchanged.
const NORMAL = [
  'Use the token from the settings page. #14 Filter by prep time, 30 min.',
  'Fix #7 and #12; see commit 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39 and a1b2c3d.',
  'Session id 123e4567-e89b-12d3-a456-426614174000 is stuck.',
  'Rename getAccessToken() to fetchAccessToken() in src/auth/token-store.ts',
  'const tokenCount = countTokens(prompt); // limit is 4096',
  'Set MAX_TOKENS=4096 in the config.',
  'const WHITESPACE_TOKENS = new Set([" ", "\\t"]);',
  'PASSWORD_MIN_LENGTH=12 is enforced by the validator.',
  'case TOKEN_EOF: return null;',
  'case TOKEN_EOF: break;',
  'The TOKEN: section of the lexer docs.',
  'RESET_TOKEN:\n- expires after 1h\n- single use',
  'Bearer tokens are required for the /admin routes.',
  'Basic authentication is disabled in production.',
  'Password: must be at least 12 characters.',
  'token: expired after 5 minutes, see #22',
  'sk-learn style estimators live in src/models.',
  'Task: skeleton-loading-state-for-dashboard-cards',
  'Branch feat/sk-ui-component-library-refresh-v2',
  'Branch feat/sk-ui-component-library-refresh-and-cleanup-v2',
  'The risk-assessment-for-payment-module-refactor ticket.',
  'Image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'See https://example.com/docs?page=2&sort=asc#section and git@github.com:org/repo.git',
  'npm install @scope/pkg@1.2.3 && https://www.npmjs.com/package/@scope/pkg',
  'Run http://localhost:3000/ and ws://127.0.0.1:8080/socket',
  'Email me at dev@example.com or ping @jade.',
  'Windows path C:\\Users\\dev\\project\\src\\index.js',
  'type Props = { token: string; onSecret?: () => void }',
  'std::string TOKEN::kind() const',
  'The API_KEY env var must be set (see README).',
  'Hash sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  'eyJ is the base64 prefix of a JSON object',
  'AKIA-prefixed ids are AWS access key ids',
  'Version 2.10.0-beta.3, node >=22, npm_config_cache is set',
  'Mention the xoxb- prefix but not a real token',
  'API_TOKEN=${API_TOKEN} and DB_PASSWORD="${DB_PASSWORD}"',
  'password: ${{ secrets.DB_PASSWORD }}',
  'set API_TOKEN=%API_TOKEN%',
  'api_token=$API_TOKEN and api_token=$(cat token.txt) and API_TOKEN="$(cat token.txt)"',
  'the token ' + rnd(40, HEX) + ' is in the log',
  'Token rotation is documented in #14',
  'const token = await getToken();',
  'API_TOKEN = get_token()',
  'PWD=/home/dev/project',
];

for (const text of NORMAL) {
  test(`leaves alone: ${JSON.stringify(text).slice(0, 60)}`, () => assert.equal(redact(text), text));
}

test('random blobs, hashes and ids are untouched', () => {
  const uuid = () => [8, 4, 4, 4, 12].map((n) => rnd(n, HEX)).join('-');
  const blobs = [
    'data:image/png;base64,' + rnd(200_000, B64),
    rnd(200_000, B64URL),
    rnd(200_000, B64).replace(/.{76}/g, '$&\n'),
    rnd(200_000, HEX),
    Array.from({ length: 5000 }, uuid).join(' '),
    Array.from({ length: 5000 }, () => rnd(40, HEX)).join('\n'),
  ];
  for (const blob of blobs) assert.equal(redact(blob), blob, blob.slice(0, 40));
});

test('assignments keep quotes, separators and following lines', () => {
  const key = 'Zq9' + rnd(30);
  assert.equal(redact(`"OPENAI_API_KEY": "${key}"`), '"OPENAI_API_KEY": "[REDACTED]"');
  assert.equal(redact("API_TOKEN='abc'\nNEXT=1"), "API_TOKEN='[REDACTED]'\nNEXT=1");
  assert.equal(redact('DB_PASSWORD=hunter2\r\nPORT=3000'), 'DB_PASSWORD=[REDACTED]\r\nPORT=3000');
  assert.equal(redact('API_TOKEN="a\\"b" rest'), 'API_TOKEN="[REDACTED]" rest');
  assert.equal(redact('x `DB_PASSWORD=hunter2` y'), 'x `DB_PASSWORD=[REDACTED]` y');
  assert.equal(redact('`DB_PASSWORD=x`'), '`DB_PASSWORD=[REDACTED]`');
  assert.equal(redact('Tokens: API_TOKEN=abc'), 'Tokens: API_TOKEN=[REDACTED]');
  assert.equal(redact('SECRET:\n  next line'), 'SECRET:\n  next line');
  assert.equal(redact('PASSWORD:   \nnext'), 'PASSWORD:   \nnext');
});

test('redaction is idempotent: reviewer regressions', () => {
  assert.equal(redact('{ API_TOKEN: "abc", DEBUG: true }'), '{ API_TOKEN: "[REDACTED]", DEBUG: true }');
  assert.equal(redact('GITHUB_TOKEN=\nNPM_TOKEN=\nPORT=3000'), 'GITHUB_TOKEN=\nNPM_TOKEN=\nPORT=3000');
  for (const text of ['{ API_TOKEN: "abc", DEBUG: true }', 'GITHUB_TOKEN=\nNPM_TOKEN=\nPORT=3000']) {
    const once = redact(text);
    assert.equal(redact(once), once);
  }
});

test('redaction is idempotent on random mixes of secrets, prose and syntax', () => {
  const fragments = [
    '=', ':', ' = ', '"', "'", '`', '\n', ';', '&', ',', '@', '/', '-', '.', '$', '{', '(', '[', ']', '\\',
    'TOKEN', 'Tokens: ', 'SECRET=', 'password', 'db_password=', '--password=', 'sig=', 'AccountKey=', 'Authorization: ',
    'Bearer ', 'basic ', 'Token ', 'https://u:', '@host/x', 'sk-', 'sk-proj-', 'ghp_', 'eyJ', 'AKIA', 'AIza', '-----BEGIN ' + 'PRIVATE KEY-----\n',
    '-----END ' + 'PRIVATE KEY-----', R, 'abc123', rnd(24), 'case ', 'export ', 'SECRET_KEY=', 'PORT=', ')&', '$', '%2B',
  ];
  const pieces = [...SECRETS.map(([, before, secret, after]) => before + secret + after), ...NORMAL, ...fragments];
  const separators = ['', '', ' ', '\n', ', ', '; ', '=', ':'];
  let state = 7;
  const pick = (list) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return list[(state >>> 8) % list.length];
  };
  for (let i = 0; i < 20_000; i++) {
    let text = '';
    for (let j = 1 + (i % 6); j > 0; j--) text += pick(pieces) + pick(separators);
    const once = redact(text);
    assert.equal(redact(once), once, JSON.stringify(text));
  }
});

test('hostile inputs of 200,000 characters stay fast (linear-time rules)', () => {
  const units = ['-eyJ', 'A_TOKEN_', '-----BEGIN ' + 'PRIVATE KEY-----\n', 'ab://c:', '-password', 'token="', 'sk-'];
  const inputs = [
    ...units.map((unit) => unit.repeat(Math.ceil(200_000 / unit.length))),
    'Bearer' + ' '.repeat(200_000) + 'x',
    'Authorization:' + ' '.repeat(100_000) + 'Basic ' + ' '.repeat(100_000),
  ];
  for (const input of inputs) {
    const start = performance.now();
    redact(input);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${JSON.stringify(input.slice(0, 20))}... (${input.length} chars) took ${ms.toFixed(0)} ms`);
  }
});
