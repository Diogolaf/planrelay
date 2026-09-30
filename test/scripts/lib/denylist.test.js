// Unit tests for the leak guard's pure logic. Every term here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_EMAIL,
  cutAtScissors,
  decodeText,
  findMatches,
  fold,
  maskTerms,
  matchText,
  parseCatFileBatch,
  parseRawDiff,
  parseRevListObjects,
  parseTerms,
  readTar,
  splitIdent,
} from '../../../scripts/lib/denylist.mjs';

const NFC = 'Élodie'; // precomposed É
const NFD = 'E\u0301lodie'; // E + combining acute accent

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
  assert.deepEqual(parseTerms(`\uFEFF${body}`), ['elodie', 'zorbacorp']);
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
  assert.equal(maskTerms('x/elodie\u0301/y', ['elodie']), 'x/***/y');
});

const SOFT_HYPHEN = '\u00AD';
const ZERO_WIDTH_SPACE = '\u200B';

test('fold removes invisible format characters', () => {
  assert.equal(fold(`zorba${SOFT_HYPHEN}corp`), 'zorbacorp');
  assert.equal(fold(`Zorba${ZERO_WIDTH_SPACE}Corp\u200D`), 'zorbacorp');
  assert.deepEqual(parseTerms(`zorba${SOFT_HYPHEN}corp`), ['zorbacorp']);
});

test('invisible characters inside a term neither hide it nor escape the mask', () => {
  const terms = ['zorbacorp'];
  const hidden = `docs/zorba${SOFT_HYPHEN}corp-notes.md`;
  assert.deepEqual(findMatches([{ path: hidden, text: `x\nZORBA${ZERO_WIDTH_SPACE}CORP` }], terms), [
    { path: hidden, line: 0, term: 1 },
    { path: hidden, line: 2, term: 1 },
  ]);
  assert.equal(maskTerms(hidden, terms), 'docs/***-notes.md');
  assert.equal(maskTerms(`a zorbacorp${ZERO_WIDTH_SPACE} b`, terms), 'a *** b');
});

test('masking covers every hit that matching finds', () => {
  const terms = parseTerms(`zorbacorp\nquux-project\n${NFC}\nΛΟΓΟΣ`);
  const samples = [
    `C:/work/ZorbaCorp/${NFD}/notes.md`,
    `zorba${SOFT_HYPHEN}corp and quux${ZERO_WIDTH_SPACE}-project`,
    'zorbacorpzorbacorp quux-projectquux-project',
    `${NFC.toUpperCase()}${NFD}`,
    'λογος and ΛΟΓΟΣ and λογοσ',
    'İzorbacorp\u0307',
  ];
  for (const sample of samples) {
    assert.ok(matchText(sample, terms).length > 0, 'the sample should match');
    assert.deepEqual(matchText(maskTerms(sample, terms), terms), [], 'masked text must not match any more');
  }
});

test('cutAtScissors drops the scissors line and everything below, whatever the comment string', () => {
  const cut = '------------------------ >8 ------------------------';
  assert.equal(cutAtScissors(`fix: x\n\n# ${cut}\n# Do not modify.\ndiff --git\n`), 'fix: x\n\n');
  assert.equal(cutAtScissors(`fix: x\n; ${cut}\nbelow\n`), 'fix: x\n');
  assert.equal(cutAtScissors('fix: x\n# not a cut line\n'), 'fix: x\n# not a cut line\n');
});

test('splitIdent separates name and e-mail', () => {
  assert.deepEqual(splitIdent('Test Placeholder <test@example.invalid> 1700000000 +0000'), {
    name: 'Test Placeholder',
    email: 'test@example.invalid',
  });
  assert.deepEqual(splitIdent('Test Placeholder <test@example.invalid>'), { name: 'Test Placeholder', email: 'test@example.invalid' });
  assert.equal(splitIdent('no e-mail here'), null);
});

test('only no-reply or placeholder commit emails are allowed', () => {
  assert.ok(ALLOWED_EMAIL.test('12345+someone@users.noreply.github.com'));
  assert.ok(ALLOWED_EMAIL.test('planrelay-dev@example.invalid'));
  assert.ok(!ALLOWED_EMAIL.test('someone@mail.example.com'));
  assert.ok(!ALLOWED_EMAIL.test('someone@mail.example.com@example.invalid'));
  assert.ok(!ALLOWED_EMAIL.test('someone@example.invalid.example.com'));
});

test('decodeText reads UTF-16 by BOM and UTF-8 otherwise', () => {
  assert.equal(decodeText(utf16('zorbacorp\n')), 'zorbacorp\n');
  assert.equal(decodeText(utf16('zorbacorp\n', true)), 'zorbacorp\n');
  assert.equal(decodeText(Buffer.from('\uFEFFzorbacorp', 'utf8')), 'zorbacorp');
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

/** A minimal ustar archive: one header block per file, its content padded to 512 bytes, two empty blocks. */
function tarOf(files) {
  const blocks = [];
  for (const { path: p, content, prefix = '', type = '0' } of files) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(p, 0, 100, 'utf8');
    header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
    header.write(type, 156, 1, 'ascii');
    header.write('ustar', 257, 6, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('readTar returns every entry with its path and content', () => {
  const entries = readTar(tarOf([
    { path: 'package/package.json', content: '{}\n' },
    { path: 'cli.js', prefix: 'package/src', content: 'x'.repeat(600) },
    { path: 'PaxHeader', type: 'x', content: '30 path=package/a-long-name.md\n' },
    { path: 'package/empty.txt', content: '' },
  ]));
  assert.deepEqual(entries.map((e) => [e.path, e.type, e.content.length]), [
    ['package/package.json', '0', 3],
    ['package/src/cli.js', '0', 600],
    ['PaxHeader', 'x', 31],
    ['package/empty.txt', '0', 0],
  ]);
  assert.equal(entries[0].content.toString('utf8'), '{}\n');
});

test('readTar refuses what is not a tar archive', () => {
  assert.throws(() => readTar(Buffer.from('not a tar archive, just some text '.repeat(40))), /malformed tar archive/);
  const cut = tarOf([{ path: 'a.txt', content: 'x'.repeat(2000) }]).subarray(0, 1024);
  assert.throws(() => readTar(cut), /malformed tar archive/);
});
