import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, parseTerms, ALLOWED_EMAIL } from '../../scripts/check-denylist.mjs';

test('parseTerms ignores blanks and comments and lowercases', () => {
  assert.deepEqual(parseTerms('# private\nZorbaCorp\n\n  quux-project  \n'), ['zorbacorp', 'quux-project']);
});

test('findMatches reports path, line and entry number, case-insensitively', () => {
  const files = [
    { path: 'docs/a.md', text: 'hello\nWorks at ZORBACORP\n' },
    { path: 'src/quux-project.js', text: 'clean' },
  ];
  assert.deepEqual(findMatches(files, ['zorbacorp', 'quux-project']), [
    { path: 'docs/a.md', line: 2, term: 1 },
    { path: 'src/quux-project.js', line: 0, term: 2 },
  ]);
});

test('findMatches returns nothing for clean files', () => {
  assert.deepEqual(findMatches([{ path: 'x.js', text: 'fine' }], ['zorbacorp']), []);
});

test('only no-reply or placeholder commit emails are allowed', () => {
  assert.ok(ALLOWED_EMAIL.test('12345+someone@users.noreply.github.com'));
  assert.ok(ALLOWED_EMAIL.test('agentboard-dev@example.invalid'));
  assert.ok(!ALLOWED_EMAIL.test('someone@mail.example.com'));
});
