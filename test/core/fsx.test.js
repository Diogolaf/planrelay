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

test('writeFileAtomic removes its temp file when the rename fails', () => {
  const dir = tempDir();
  const target = path.join(dir, 'taken');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'inside'), 'x'); // a non-empty folder cannot be replaced by a file
  assert.throws(() => writeFileAtomic(target, 'data'), (err) => typeof err.code === 'string');
  assert.deepEqual(fs.readdirSync(dir), ['taken']);
});

test('readJson returns the fallback for missing or corrupt files', () => {
  const dir = tempDir();
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.equal(readJson(path.join(dir, 'bad.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  assert.equal(readJson(path.join(dir, 'empty.json'), 'fb'), 'fb');
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
