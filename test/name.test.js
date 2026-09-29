import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAME, CONFIG_DIR } from '../src/name.js';

test('name constants are the single rename point', () => {
  assert.equal(NAME, 'agentboard');
  assert.equal(CONFIG_DIR, '.agentboard');
});
