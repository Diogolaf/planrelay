import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { withLock, pidAlive } from '../../src/core/mutex.js';
import { HOUR, MIN, tempDir } from '../helpers.js';

const mutexUrl = new URL('../../src/core/mutex.js', import.meta.url).href;
/** Never a running process: above every platform's pid limit, and odd (Windows pids are multiples of 4). */
const DEAD_PID = 2 ** 31 - 1;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

/** Writes `<dir>/lock` (an object is stored as JSON) and backdates its mtime by `ageMs`. */
function writeLock(dir, content, ageMs = 0) {
  const file = path.join(dir, 'lock');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  }
  return file;
}

function eperm() {
  return Object.assign(new Error('EPERM: operation not permitted (simulated)'), { code: 'EPERM' });
}

test('withLock returns what fn returns, holding a lock that names this process', () => {
  const dir = path.join(tempDir(), 'board');
  const out = withLock(dir, () => JSON.parse(fs.readFileSync(path.join(dir, 'lock'), 'utf8')));
  assert.equal(out.pid, process.pid);
  assert.equal(typeof out.token, 'string');
  assert.ok(Math.abs(out.at - Date.now()) < MIN);
  assert.deepEqual(fs.readdirSync(dir), []);
});

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
  assert.deepEqual(fs.readdirSync(dir), ['counter']);
});

test('several waiters on one stale lock take it over one at a time', async () => {
  const worker = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { withLock } from ${JSON.stringify(mutexUrl)};
    const [dir, startAt] = process.argv.slice(1);
    const counter = path.join(dir, 'counter');
    while (Date.now() < Number(startAt)) {} // every worker meets the stale lock at the same moment
    withLock(dir, () => {
      const n = Number(fs.readFileSync(counter, 'utf8'));
      const t = Date.now();
      while (Date.now() - t < 20) {} // hold it long enough for a second taker to interfere
      fs.writeFileSync(counter, String(n + 1));
    });`;
  for (let trial = 0; trial < 3; trial++) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'counter'), '0');
    writeLock(dir, { pid: DEAD_PID, at: Date.now() - MIN });
    const startAt = Date.now() + 1000;
    await Promise.all(Array.from({ length: 6 }, () => run(['--input-type=module', '-e', worker, dir, String(startAt)])));
    assert.equal(fs.readFileSync(path.join(dir, 'counter'), 'utf8'), '6', `trial ${trial}`);
    assert.deepEqual(fs.readdirSync(dir), ['counter']);
  }
});

test('a stale lock from a dead process is taken over', () => {
  const dir = tempDir();
  writeLock(dir, { pid: DEAD_PID, at: Date.now() - MIN });
  assert.equal(withLock(dir, () => 'ran'), 'ran');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a lock from a dead process is respected for its first 10 s', () => {
  const dir = tempDir();
  writeLock(dir, { pid: DEAD_PID, at: Date.now() });
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 100 }), /locked/);
});

test('a fresh lock held by a live process times out, naming the lock and its holder', () => {
  const dir = tempDir();
  const file = writeLock(dir, { pid: process.pid, at: Date.now() });
  const start = performance.now();
  assert.throws(
    () => withLock(dir, () => 'never', { timeoutMs: 100 }),
    (err) => /locked/.test(err.message) && err.message.includes(file) && err.message.includes(`pid ${process.pid}`),
  );
  assert.ok(performance.now() - start >= 100);
  assert.deepEqual(fs.readdirSync(dir), ['lock']); // someone else's lock is left alone
});

test('a lock older than the hard ceiling is taken over even though its process is alive', () => {
  const dir = tempDir();
  writeLock(dir, { pid: process.pid, at: Date.now() - 3 * MIN });
  assert.equal(withLock(dir, () => 'ran'), 'ran');
});

test('an unparseable lock is judged by its mtime', () => {
  const old = tempDir();
  writeLock(old, '{half a lo', 30_000);
  assert.equal(withLock(old, () => 'ran'), 'ran');

  const fresh = tempDir();
  writeLock(fresh, '{half a lo');
  assert.throws(() => withLock(fresh, () => 'never', { timeoutMs: 100 }), /held by pid unknown/);
});

test('a lock time that is not a number, or far in the future, falls back to the mtime', () => {
  for (const at of ['yesterday', null, Date.now() + HOUR]) {
    const old = tempDir();
    writeLock(old, { pid: DEAD_PID, at }, 30_000);
    assert.equal(withLock(old, () => 'ran'), 'ran', `at=${at}, old mtime`);

    const fresh = tempDir();
    writeLock(fresh, { pid: DEAD_PID, at });
    assert.throws(() => withLock(fresh, () => 'never', { timeoutMs: 50 }), /locked/, `at=${at}, fresh mtime`);
  }
});

test('the timeout still fires, after sleeping between attempts, when a stale lock cannot be deleted', () => {
  const dir = tempDir();
  const file = writeLock(dir, { pid: DEAD_PID, at: Date.now() - MIN });
  let attempts = 0;
  const io = {
    unlink(p) {
      if (p !== file) return fs.unlinkSync(p);
      attempts++;
      throw eperm();
    },
  };
  const start = performance.now();
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 200, io }), (err) => err.message.includes(`held by pid ${DEAD_PID}`));
  assert.ok(performance.now() - start >= 200);
  assert.ok(attempts >= 2 && attempts <= 30, `${attempts} delete attempts in 200 ms`);
  assert.deepEqual(fs.readdirSync(dir), ['lock']); // the takeover guard was released
});

test('a takeover guard left by a crashed process is removed after 10 s', () => {
  const dir = tempDir();
  writeLock(dir, { pid: DEAD_PID, at: Date.now() - MIN });
  const guard = path.join(dir, 'lock.break');
  fs.writeFileSync(guard, String(DEAD_PID));
  const t = new Date(Date.now() - 30_000);
  fs.utimesSync(guard, t, t);
  assert.equal(withLock(dir, () => 'ran'), 'ran');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a live takeover guard keeps other processes from breaking the stale lock', () => {
  const dir = tempDir();
  writeLock(dir, { pid: DEAD_PID, at: Date.now() - MIN });
  fs.writeFileSync(path.join(dir, 'lock.break'), String(process.pid));
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 100 }), /locked/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['lock', 'lock.break']);
});

test('release leaves alone a lock that another process took over meanwhile', () => {
  const dir = tempDir();
  const file = path.join(dir, 'lock');
  withLock(dir, () => {
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), token: 'someone-else' }));
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'someone-else');
});

test('an error from fn propagates and the lock is released', () => {
  const dir = tempDir();
  assert.throws(() => withLock(dir, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(withLock(dir, () => 'again'), 'again');
});

test('a nested withLock on the same folder throws instead of waiting on itself', () => {
  const dir = tempDir();
  assert.throws(() => withLock(dir, () => withLock(dir, () => 'inner')), /not re-entrant/);
  assert.throws(() => withLock(dir, () => withLock(dir + path.sep, () => 'inner')), /not re-entrant/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(withLock(dir, () => withLock(tempDir(), () => 'other folder')), 'other folder');
  assert.equal(withLock(dir, () => 'after'), 'after');
});

test('busy errors while creating the lock are retried on Windows and thrown elsewhere', () => {
  const dir = tempDir();
  const file = path.join(dir, 'lock');
  let failures = 3;
  const io = {
    create(p, body) {
      if (p === file && failures-- > 0) throw eperm();
      fs.writeFileSync(p, body, { flag: 'wx' });
    },
  };
  if (process.platform === 'win32') assert.equal(withLock(dir, () => 'ran', { io }), 'ran');
  else assert.throws(() => withLock(dir, () => 'never', { io }), { code: 'EPERM' });
});

test('a busy error that lasts past the timeout is thrown when no lock file exists', () => {
  const dir = tempDir();
  const io = { create: () => { throw eperm(); } };
  assert.throws(() => withLock(dir, () => 'never', { timeoutMs: 100, io }), { code: 'EPERM' });
});

test('pidAlive', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(DEAD_PID), false);
  for (const bad of [0, -1, 1.5, '1', undefined, null]) assert.equal(pidAlive(bad), false, String(bad));
});
