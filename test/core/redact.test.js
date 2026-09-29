import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../src/core/redact.js';

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
  assert.equal(redact('export STRIPE_SECRET="abc def"'), 'export STRIPE_SECRET=[REDACTED]');
  assert.equal(redact('MY_API_KEY: xyz'), 'MY_API_KEY=[REDACTED]');
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
