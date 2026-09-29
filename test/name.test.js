import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NAME, CONFIG_DIR } from '../src/name.js';

test('name constants are the single rename point', () => {
  assert.equal(NAME, 'agentboard');
  assert.equal(CONFIG_DIR, '.agentboard');
});

test('package metadata uses the same name', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.name, NAME);
  assert.deepEqual(Object.keys(pkg.bin), [NAME]);
});
