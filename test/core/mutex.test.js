import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withLock, pidAlive } from '../../src/core/mutex.js';
import { tempDir } from '../helpers.js';

const mutexUrl = pathToFileURL(path.resolve('src/core/mutex.js')).href;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

test('concurrent processes never lose an increment', async () => {
  const dir = tempDir();
  const counter = path.join(dir, 'counter');
  fs.writeFileSync(counter, '0');
  const worker = `
    import fs from 'node:fs';
    import { withLock } from ${JSON.stringify(mutexUrl)};
    const [dir, file] = process.argv.slice(1);
    for (let i = 0; i < 50; i++) {
      withLock(dir, () => fs.writeFileSync(file, String(Number(fs.readFileSync(file, 'utf8')) + 1)));
    }`;
  await Promise.all([1, 2, 3, 4].map(() => run(['--input-type=module', '-e', worker, dir, counter])));
  assert.equal(fs.readFileSync(counter, 'utf8'), '200');
  assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
});

test('a stale lock from a dead process is taken over', () => {
  const dir = tempDir();
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: dead, at: Date.now() - 60_000 }));
  assert.equal(withLock(dir, () => 'ran'), 'ran');
});

test('a fresh lock held by a live process times out', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 100 }), /locked/);
});

test('pidAlive', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(spawnSync(process.execPath, ['-e', '0']).pid), false);
});
