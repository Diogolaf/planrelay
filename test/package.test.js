import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTar } from '../scripts/lib/denylist.mjs';
import { npmPack } from '../scripts/lib/pack.mjs';
import { NAME } from '../src/name.js';
import { gitEnv, tempDir, tempRepo } from './helpers.js';

/** The environment of a child process: no session variables inherited from a Claude Code session running the tests. */
const childEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(gitEnv()).filter(([k]) => !k.toUpperCase().startsWith('CLAUDE'))),
  ...extra,
});

let unpacked;
/** The real `npm pack` output, unpacked once into a folder with a space in its path. */
function packedPackage() {
  if (unpacked) return unpacked;
  const dest = tempDir();
  const entries = readTar(zlib.gunzipSync(fs.readFileSync(npmPack(path.resolve('.'), dest))));
  const root = path.join(dest, 'Installed Packages');
  for (const e of entries.filter((x) => x.type === '0')) {
    const abs = path.join(root, e.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.content);
  }
  unpacked = { entries, dir: path.join(root, 'package') };
  return unpacked;
}

/** GET a path of a local server; resolves with the status, content type and body. @param {number} port @param {string} reqPath */
function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

async function waitFor(check, timeoutMs = 10000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('the package ships the runtime files and nothing else', () => {
  const { entries } = packedPackage();
  assert.deepEqual([...new Set(entries.map((e) => e.type))], ['0'], 'only regular files, no extended headers');
  const shipped = entries.map((e) => e.path.replace(/^package\//, '')).sort();
  const tracked = execFileSync('git', ['ls-files', 'src', 'hooks', 'skills', '.claude-plugin', 'LICENSE', 'README.md', 'package.json'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).sort();
  assert.deepEqual(shipped, tracked);
  // the dashboard's fonts ship with their licenses
  assert.ok(shipped.some((p) => /^src\/dashboard\/ui\/fonts\/LICENSE-/.test(p)));
});

test('package metadata', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packedPackage().dir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, NAME);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.engines, { node: '>=22' });
  assert.deepEqual(pkg.bin, { [NAME]: 'src/cli.js' });
  assert.ok(pkg.keywords.includes('claude-code'));
  assert.match(fs.readFileSync(path.join(packedPackage().dir, 'src/cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('the packed package runs: help, a hook and the agent tools', async () => {
  const cli = path.join(packedPackage().dir, 'src/cli.js');
  const repo = tempRepo();
  const env = childEnv({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CODE_SESSION_ID: 's1', CLAUDE_PID: String(process.pid) });

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env, cwd: repo });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: planrelay <hook\|mcp\|repair\|dashboard>/);

  const r = spawnSync(process.execPath, [cli, 'hook'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: repo, source: 'startup' }), encoding: 'utf8', env, cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you are agent Amber/);

  const child = spawn(process.execPath, [cli, 'mcp'], { env, cwd: repo });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(JSON.parse(out).result.tools.length, 10);
  } finally {
    child.kill();
  }
});

test('the packed package serves the dashboard with its fonts', async () => {
  const cli = path.join(packedPackage().dir, 'src/cli.js');
  const child = spawn(process.execPath, [cli, 'dashboard', '--no-open', '--port', '0', '--dir', tempRepo()], { env: childEnv() });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { err += c.toString(); });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await waitFor(() => out.includes('\n') || err !== '');
    const m = /^planrelay dashboard for .+: http:\/\/127\.0\.0\.1:(\d+)\/ \(Ctrl\+C to stop\)\n$/.exec(out);
    assert.ok(m, `stdout: ${out} stderr: ${err}`);
    const port = Number(m[1]);

    const page = await get(port, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    const css = await get(port, '/ui/app.css');
    assert.equal(css.status, 200);
    const font = /url\((fonts\/[\w.-]+\.woff2)\)/.exec(css.body.toString('utf8'));
    assert.ok(font, 'app.css names a font');
    const res = await get(port, `/ui/${font[1]}`);
    assert.equal(res.status, 200);
    assert.equal(res.type, 'font/woff2');
    assert.ok(res.body.length > 1000);
  } finally {
    child.kill();
    await exited;
  }
});
