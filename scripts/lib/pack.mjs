// Packing the npm package, for the leak guard (scripts/check-pack.mjs) and the package tests.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Runs `npm pack` for the package in `root` and returns the path of the tarball it wrote in `dest`.
 * Under `npm run` and `npm test`, npm's own CLI file is known (npm_execpath) and runs with this
 * Node. Otherwise `npm` is found on PATH through a shell, because it is a .cmd file on Windows.
 * @param {string} root @param {string} dest an existing folder
 */
export function npmPack(root, dest) {
  const args = ['pack', '--json', '--pack-destination', dest];
  const cli = process.env.npm_execpath;
  const r = cli && /npm-cli\.js$/.test(cli)
    ? spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
    : spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { cwd: root, encoding: 'utf8', shell: true });
  if (r.status !== 0) throw new Error(`npm pack failed (exit ${r.status}): ${String(r.stderr).trim()}`);
  const [{ filename }] = JSON.parse(r.stdout);
  return path.join(dest, filename);
}
