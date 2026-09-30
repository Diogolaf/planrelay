#!/usr/bin/env node
// Packs the npm package into a temp folder and runs the leak guard over the tarball
// (npm run check:pack, CI). The tarball is removed afterwards.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmPack } from './lib/pack.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'planrelay-pack-'));
try {
  const tarball = npmPack(ROOT, dest);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-denylist.mjs'), '--tarball', tarball], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} catch {
  console.error('check-pack: npm pack failed; nothing was approved.');
  process.exitCode = 1;
} finally {
  fs.rmSync(dest, { recursive: true, force: true });
}
