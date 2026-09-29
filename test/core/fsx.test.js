import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeFileAtomic, writeJsonAtomic, appendLine, readLines, fileSize } from '../../src/core/fsx.js';
import { tempDir } from '../helpers.js';

test('writeJsonAtomic then readJson round-trips and creates folders', () => {
  const file = path.join(tempDir(), 'a', 'b', 'x.json');
  writeJsonAtomic(file, { n: 1 });
  assert.deepEqual(readJson(file, null), { n: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']); // no temp files left
});

test('writeJsonAtomic is pretty by default and compact with pretty: false', () => {
  const dir = tempDir();
  writeJsonAtomic(path.join(dir, 'pretty.json'), { a: [1] });
  assert.equal(fs.readFileSync(path.join(dir, 'pretty.json'), 'utf8'), '{\n  "a": [\n    1\n  ]\n}\n');
  writeJsonAtomic(path.join(dir, 'compact.json'), { a: [1] }, { pretty: false });
  assert.equal(fs.readFileSync(path.join(dir, 'compact.json'), 'utf8'), '{"a":[1]}\n');
});

test('writeFileAtomic replaces an existing file and leaves no temp files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'old content that is longer');
  writeFileAtomic(file, 'new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  writeFileAtomic(file, 'newer');
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer');
  assert.deepEqual(fs.readdirSync(dir), ['x.txt']);
});

function ioError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// Every rename failure a real folder can produce on Windows is a busy error, retried for 2 s,
// so the failures below are simulated.
test('writeFileAtomic removes its temp file when the rename fails', (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'old');
  t.mock.method(fs, 'renameSync', () => { throw ioError('EXDEV'); }); // never retried
  assert.throws(() => writeFileAtomic(file, 'new'), { code: 'EXDEV' });
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(dir), ['x.txt']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});

test('writeFileAtomic retries a busy rename on Windows only', (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'x.txt');
  const rename = fs.renameSync;
  let failures = 2;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failures-- > 0) throw ioError('EPERM');
    return rename(from, to);
  });
  if (process.platform === 'win32') {
    writeFileAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  } else {
    assert.throws(() => writeFileAtomic(file, 'new'), { code: 'EPERM' });
  }
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(dir), process.platform === 'win32' ? ['x.txt'] : []);
});

test('readJson returns the fallback for missing or corrupt files', () => {
  const dir = tempDir();
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.equal(readJson(path.join(dir, 'bad.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  assert.equal(readJson(path.join(dir, 'empty.json'), 'fb'), 'fb');
});

test('readJson ignores one leading UTF-8 BOM', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bom.json'), '\uFEFF{"n":1}');
  assert.deepEqual(readJson(path.join(dir, 'bom.json'), 'fb'), { n: 1 });
  fs.writeFileSync(path.join(dir, 'two.json'), '\uFEFF\uFEFF{"n":1}'); // only one is stripped
  assert.equal(readJson(path.join(dir, 'two.json'), 'fb'), 'fb');
});

test('readJson throws errors other than a missing file', () => {
  const dir = tempDir(); // a folder cannot be read as a file
  assert.throws(() => readJson(dir, 'fb'), { code: 'EISDIR' });
});

test('appendLine and readLines', () => {
  const file = path.join(tempDir(), 'log', 'x.jsonl');
  assert.deepEqual(readLines(file), []);
  appendLine(file, 'one');
  appendLine(file, 'two');
  assert.deepEqual(readLines(file), ['one', 'two']);
});

test('readLines skips blank lines and throws errors other than a missing file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, 'one\n\n  \ntwo\n');
  assert.deepEqual(readLines(file), ['one', 'two']);
  assert.throws(() => readLines(dir), { code: 'EISDIR' });
});

test('fileSize is the size in bytes, or 0 for a missing file', () => {
  const dir = tempDir();
  const file = path.join(dir, 'x.txt');
  assert.equal(fileSize(file), 0);
  fs.writeFileSync(file, 'héllo'); // 6 bytes in UTF-8
  assert.equal(fileSize(file), 6);
});
