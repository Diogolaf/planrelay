import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, appendLine, readLines } from '../../src/core/fsx.js';
import { tempDir } from '../helpers.js';

test('writeJsonAtomic then readJson round-trips and creates folders', () => {
  const file = path.join(tempDir(), 'a', 'b', 'x.json');
  writeJsonAtomic(file, { n: 1 });
  assert.deepEqual(readJson(file, null), { n: 1 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']); // no temp files left
});

test('readJson returns the fallback for missing or corrupt files', () => {
  const dir = tempDir();
  assert.equal(readJson(path.join(dir, 'missing.json'), 'fb'), 'fb');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.equal(readJson(path.join(dir, 'bad.json'), 'fb'), 'fb');
});

test('appendLine and readLines', () => {
  const file = path.join(tempDir(), 'log', 'x.jsonl');
  assert.deepEqual(readLines(file), []);
  appendLine(file, 'one');
  appendLine(file, 'two');
  assert.deepEqual(readLines(file), ['one', 'two']);
});
