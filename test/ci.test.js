import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const count = (text) => yml.split(text).length - 1;

test('every action is pinned to a commit, with its version in a comment', () => {
  const uses = [...yml.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 7, `${uses.length} actions`);
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^actions\/[\w-]+@[0-9a-f]{40}$/, ref);
    assert.match(rest, /#\s*v\d+\.\d+\.\d+/, ref);
  }
});

test('no job keeps the checkout token, and the workflow can only read', () => {
  assert.equal(count('persist-credentials: false'), count('actions/checkout@'));
  assert.match(yml, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(yml, /pull_request_target/);
});

test('the leak checks: gitleaks is verified by checksum; the denylist covers files, history and the package', () => {
  assert.match(yml, /GITLEAKS_SHA256: [0-9a-f]{64}\b/);
  assert.match(yml, /sha256sum -c/);
  for (const command of ['check-denylist.mjs --all', 'check-denylist.mjs --history', 'npm run check:pack']) assert.ok(yml.includes(command), command);
  assert.ok(count('fetch-depth: 0') >= 2, 'gitleaks and the denylist read the full history');
});

test('the browser tests run on Linux', () => {
  assert.match(yml, /playwright install --with-deps chromium/);
  assert.match(yml, /npm run test:ui/);
});
