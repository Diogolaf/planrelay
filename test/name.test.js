import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NAME, CONFIG_DIR } from '../src/name.js';

test('name constants are the single rename point', () => {
  assert.equal(NAME, 'planrelay');
  assert.equal(CONFIG_DIR, '.planrelay');
});

test('package metadata uses the same name', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, NAME);
  assert.deepEqual(Object.keys(pkg.bin), [NAME]);
});
