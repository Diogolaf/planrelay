import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../src/core/config.js';
import { openBoard } from '../src/core/store.js';
import { buildTools } from '../src/mcp/tools.js';
import { tempRepo } from './helpers.js';

const readme = fs.readFileSync('README.md', 'utf8');

test('every relative link and image of the README points at a file of the repository', () => {
  const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(https?:|#|mailto:)/.test(t));
  assert.ok(targets.length >= 5, `${targets.length} relative links`);
  for (const t of targets) assert.ok(fs.existsSync(path.normalize(t.split('#')[0])), t);
  for (const shot of ['docs/design/overview.png', 'docs/design/board.png', 'docs/design/task.png']) assert.ok(targets.includes(shot), shot);
});

test('the README states the requirements and documents every option and tool', () => {
  assert.match(readme, /Claude Code 2\.1\.139 or newer/);
  assert.match(readme, /Node\.js 22 or newer/);
  for (const option of Object.keys(DEFAULTS)) assert.ok(readme.includes(`\`${option}\``), option);
  for (const tool of buildTools(openBoard(tempRepo()), { folder: '.' })) assert.ok(readme.includes(`\`${tool.name}\``), tool.name);
  for (const flag of ['--port', '--dir', '--no-open']) assert.ok(readme.includes(flag), flag);
});
