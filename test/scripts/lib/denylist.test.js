// Unit tests for the leak guard's pure logic. Every term here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_EMAIL,
  decodeText,
  findMatches,
  fold,
  maskTerms,
  matchText,
  parseCatFileBatch,
  parseRawDiff,
  parseRevListObjects,
  parseTerms,
} from '../../../scripts/lib/denylist.mjs';

const NFC = 'Élodie'; // precomposed É
const NFD = 'Élodie'; // E + combining acute accent

/** Encodes text as UTF-16 with a BOM. */
function utf16(text, bigEndian = false) {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return bigEndian ? Buffer.from(le).swap16() : le;
}

test('parseTerms ignores blanks and comments and lowercases', () => {
  assert.deepEqual(parseTerms('# private\nZorbaCorp\n\n  quux-project  \n'), ['zorbacorp', 'quux-project']);
});

test('parseTerms accepts CRLF and lone CR line endings', () => {
  assert.deepEqual(parseTerms('ZorbaCorp\r\nquux-project\rthird-term'), ['zorbacorp', 'quux-project', 'third-term']);
});

test('parseTerms decodes UTF-8 with and without a BOM', () => {
  const body = `# list\n${NFC}\nZorbaCorp\n`;
  assert.deepEqual(parseTerms(Buffer.from(body, 'utf8')), ['elodie', 'zorbacorp']);
  assert.deepEqual(parseTerms(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')])), ['elodie', 'zorbacorp']);
  assert.deepEqual(parseTerms(`﻿${body}`), ['elodie', 'zorbacorp']);
});

test('parseTerms decodes UTF-16LE and UTF-16BE by BOM', () => {
  const body = `# list\r\n${NFC}\r\nQuux-Project\r\n`;
  assert.deepEqual(parseTerms(utf16(body)), ['elodie', 'quux-project']);
  assert.deepEqual(parseTerms(utf16(body, true)), ['elodie', 'quux-project']);
});

test('parseTerms folds accents and case, whatever the normalization form', () => {
  assert.deepEqual(parseTerms(`${NFC}\n${NFD}\nÉLODIE\nelodie`), ['elodie', 'elodie', 'elodie', 'elodie']);
});

test('parseTerms fails loudly on control characters, without echoing the term', () => {
  // UTF-16 without a BOM, read as UTF-8, is full of NULs.
  const noBom = Buffer.from('zorbacorp\nquux-project\n', 'utf16le');
  assert.throws(() => parseTerms(noBom), (err) => /control character/.test(err.message) && !/zorbacorp/i.test(err.message));
  assert.throws(() => parseTerms('ok-term\nzorba\u0000corp'), /line 2 .*control character/);
  assert.throws(() => parseTerms('zorba\u0007corp'), /control character/);
});

test('parseTerms rejects bytes that are not valid UTF-8', () => {
  // "Élodie" in Latin-1: 0xC9 is not valid UTF-8 on its own.
  assert.throws(() => parseTerms(Buffer.from([0xc9, 0x6c, 0x6f, 0x64, 0x69, 0x65])), /not valid UTF-8/);
});

test('fold is idempotent and ignores case, accents and final sigma', () => {
  assert.equal(fold(NFC), 'elodie');
  assert.equal(fold(NFD), 'elodie');
  assert.equal(fold(fold('ÀÉÎÕÜ Ç')), fold('ÀÉÎÕÜ Ç'));
  assert.equal(fold('ΛΟΓΟΣ'), fold('λογος'));
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

test('findMatches matches NFD text against an NFC term', () => {
  const files = [{ path: 'notes.md', text: `first line\nsigned ${NFD}\n` }];
  assert.deepEqual(findMatches(files, [NFC]), [{ path: 'notes.md', line: 2, term: 1 }]);
});

test('findMatches ignores accents in both directions', () => {
  const terms = parseTerms(NFC);
  assert.deepEqual(findMatches([{ path: 'a.txt', text: 'ELODIE' }], terms), [{ path: 'a.txt', line: 1, term: 1 }]);
  assert.deepEqual(findMatches([{ path: 'a.txt', text: 'élodie' }], ['elodie']), [{ path: 'a.txt', line: 1, term: 1 }]);
  assert.deepEqual(findMatches([{ path: `docs/${NFD}.md`, text: '' }], terms), [{ path: `docs/${NFD}.md`, line: 0, term: 1 }]);
});

test('matchText numbers lines from 1 and reports every entry', () => {
  assert.deepEqual(matchText('a\nzorbacorp and QUUX-PROJECT', ['zorbacorp', 'quux-project']), [
    { line: 2, term: 1 },
    { line: 2, term: 2 },
  ]);
});

test('maskTerms hides every variant of every term and keeps the rest', () => {
  const terms = parseTerms(`zorbacorp\n${NFC}\nquux-project`);
  assert.equal(maskTerms('docs/ZorbaCorp-notes.md', terms), 'docs/***-notes.md');
  assert.equal(maskTerms(`by ${NFC} and ${NFD} and ELODIE`, terms), 'by *** and *** and ***');
  assert.equal(maskTerms('zorbacorpzorbacorp/quux-project', terms), '***/***');
  assert.equal(maskTerms('nothing to hide', terms), 'nothing to hide');
  assert.equal(maskTerms('zorbacorp', []), 'zorbacorp');
});

test('maskTerms swallows accents that trail the match', () => {
  // "elodié" with a combining accent on the last letter.
  assert.equal(maskTerms('x/elodié/y', ['elodie']), 'x/***/y');
});

test('only no-reply or placeholder commit emails are allowed', () => {
  assert.ok(ALLOWED_EMAIL.test('12345+someone@users.noreply.github.com'));
  assert.ok(ALLOWED_EMAIL.test('agentboard-dev@example.invalid'));
  assert.ok(!ALLOWED_EMAIL.test('someone@mail.example.com'));
  assert.ok(!ALLOWED_EMAIL.test('someone@mail.example.com@example.invalid'));
  assert.ok(!ALLOWED_EMAIL.test('someone@example.invalid.example.com'));
});

test('decodeText reads UTF-16 by BOM and UTF-8 otherwise', () => {
  assert.equal(decodeText(utf16('zorbacorp\n')), 'zorbacorp\n');
  assert.equal(decodeText(utf16('zorbacorp\n', true)), 'zorbacorp\n');
  assert.equal(decodeText(Buffer.from('﻿zorbacorp', 'utf8')), 'zorbacorp');
  assert.equal(decodeText(Buffer.from(NFC, 'utf8')), NFC);
});

test('parseRawDiff reads single-path and rename entries', () => {
  const a = '1'.repeat(40);
  const b = '2'.repeat(40);
  const out = `:000000 100644 ${'0'.repeat(40)} ${a} A\0new.txt\0:100644 100644 ${a} ${b} R090\0old.txt\0moved.txt\0`;
  assert.deepEqual(parseRawDiff(out), [
    { srcMode: '000000', dstMode: '100644', srcSha: '0'.repeat(40), dstSha: a, status: 'A', path: 'new.txt' },
    { srcMode: '100644', dstMode: '100644', srcSha: a, dstSha: b, status: 'R', path: 'moved.txt' },
  ]);
});

test('parseCatFileBatch splits objects by size and flags missing ones', () => {
  const a = 'a'.repeat(40);
  const out = Buffer.from(`${a} blob 4\nx\ny\n\n${'b'.repeat(40)} missing\n`);
  const objects = parseCatFileBatch(out);
  assert.equal(objects.length, 2);
  assert.equal(objects[0].sha, a);
  assert.equal(objects[0].content.toString(), 'x\ny\n');
  assert.equal(objects[1].missing, true);
  assert.throws(() => parseCatFileBatch(Buffer.from(`${a} blob 99\nshort\n`)), /truncated/);
});

test('parseRevListObjects keeps the path after the first space', () => {
  const a = 'c'.repeat(40);
  assert.deepEqual(parseRevListObjects(`${a}\n${a} dir/with space.txt\n`), [
    { sha: a, path: '' },
    { sha: a, path: 'dir/with space.txt' },
  ]);
});
