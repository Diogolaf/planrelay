import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, loadConfig, parseConfig, readConfig, rulesPath } from '../../src/core/config.js';
import { tempDir } from '../helpers.js';

/** A project folder whose config.json holds `content` (an object, a string or raw bytes). */
function withConfig(content) {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.planrelay'));
  const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(root, '.planrelay', 'config.json'), data);
  return root;
}

/** parseConfig of an object, as JSON text. */
const parse = (obj) => parseConfig(JSON.stringify(obj));

test('defaults when there is no config file', () => {
  assert.deepEqual(DEFAULTS, {
    agentTasksNeedApproval: true, locks: 'auto', lockMinutes: 30, claimTimeoutHours: 24, idleMinutes: 15, maxPings: 8,
  });
  assert.ok(Object.isFrozen(DEFAULTS));
  const root = tempDir();
  assert.deepEqual(readConfig(root), { config: DEFAULTS, problems: [] });
  assert.deepEqual(loadConfig(root), DEFAULTS);
});

test('valid values override defaults', () => {
  const cfg = loadConfig(withConfig({ agentTasksNeedApproval: false, locks: 'off', maxPings: 3 }));
  assert.equal(cfg.agentTasksNeedApproval, false);
  assert.equal(cfg.locks, 'off');
  assert.equal(cfg.maxPings, 3);
  assert.equal(cfg.lockMinutes, 30);
  assert.deepEqual(readConfig(withConfig({ lockMinutes: 5, idleMinutes: 1.5, claimTimeoutHours: 8760 })), {
    config: { ...DEFAULTS, lockMinutes: 5, idleMinutes: 1.5, claimTimeoutHours: 8760 },
    problems: [],
  });
});

test('a UTF-8 BOM is accepted, from a file and from a string', () => {
  assert.deepEqual(readConfig(withConfig('\uFEFF{"maxPings":3}')), { config: { ...DEFAULTS, maxPings: 3 }, problems: [] });
  assert.deepEqual(parseConfig('\uFEFF{"maxPings":3}'), { config: { ...DEFAULTS, maxPings: 3 }, problems: [] });
});

test('UTF-16 with a BOM is accepted (Notepad "Unicode", PowerShell 5 Out-File)', () => {
  const text = '\uFEFF{ "maxPings": 3, "locks": "off" }\r\n';
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.from(le).swap16();
  const expected = { config: { ...DEFAULTS, maxPings: 3, locks: 'off' }, problems: [] };
  assert.deepEqual(readConfig(withConfig(le)), expected);
  assert.deepEqual(readConfig(withConfig(be)), expected);
  assert.deepEqual(parseConfig(new Uint8Array(le)), expected);
});

test('an unreadable config (a folder at config.json) means defaults and one problem', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.planrelay', 'config.json'), { recursive: true });
  const { config, problems } = readConfig(root);
  assert.equal(config, DEFAULTS);
  assert.deepEqual(problems, ['could not read .planrelay/config.json (EISDIR)']);
  assert.deepEqual(loadConfig(root), DEFAULTS);
});

test('a file where the .planrelay folder should be counts as no config (ENOTDIR like ENOENT)', (t) => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, '.planrelay'), 'not a folder');
  assert.deepEqual(readConfig(root), { config: DEFAULTS, problems: [] }); // ENOENT on Windows, ENOTDIR on POSIX
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('simulated'), { code: 'ENOTDIR' }); });
  assert.deepEqual(readConfig(root), { config: DEFAULTS, problems: [] });
});

test('other read errors (for example EACCES) mean defaults and one problem', (t) => {
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('simulated'), { code: 'EACCES' }); });
  assert.deepEqual(readConfig(tempDir()), { config: DEFAULTS, problems: ['could not read .planrelay/config.json (EACCES)'] });
});

test('readConfig never throws, even for a bad root', () => {
  const { config, problems } = readConfig(/** @type {any} */ (undefined));
  assert.equal(config, DEFAULTS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^could not read \.planrelay\/config\.json \(/);
});

test('invalid JSON (trailing comma, comments, empty) means defaults and one problem', () => {
  for (const text of ['{"maxPings":3,}', '{\n  // quiet\n  "maxPings": 3\n}', '', '{"maxPings":3']) {
    const { config, problems } = readConfig(withConfig(text));
    assert.equal(config, DEFAULTS, text);
    assert.equal(problems.length, 1, text);
    assert.match(problems[0], /^not valid JSON \(.+\); using defaults$/, text);
  }
  assert.deepEqual(parseConfig('{"maxPings":3,}').problems, [
    'not valid JSON (Expected double-quoted property name in JSON at position 14 (line 1 column 15)); using defaults',
  ]);
});

test('JSON that is not an object means defaults and one problem', () => {
  assert.deepEqual(parseConfig('null'), { config: DEFAULTS, problems: ['must be a JSON object, not null; using defaults'] });
  assert.deepEqual(parseConfig('[{"maxPings":3}]'), { config: DEFAULTS, problems: ['must be a JSON object, not an array; using defaults'] });
  assert.deepEqual(parseConfig('5').problems, ['must be a JSON object, not a number; using defaults']);
  assert.deepEqual(parseConfig('"x"').problems, ['must be a JSON object, not a string; using defaults']);
});

test('an unknown key is reported but does not discard valid keys', () => {
  assert.deepEqual(parse({ maxPings: 3, extra: 1 }), { config: { ...DEFAULTS, maxPings: 3 }, problems: ['unknown option "extra"'] });
  const long = parse({ ['x'.repeat(100)]: 1, maxPing: 3 }).problems;
  assert.deepEqual(long, [`unknown option "${'x'.repeat(40)}"`, 'unknown option "maxPing"']);
});

test('__proto__ and constructor keys are unknown options and pollute nothing', () => {
  const { config, problems } = parseConfig(
    '{"__proto__":{"maxPings":3,"locks":"off"},"constructor":{"prototype":{"maxPings":3}},"lockMinutes":5}',
  );
  assert.deepEqual(config, { ...DEFAULTS, lockMinutes: 5 });
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal(Object.hasOwn(config, '__proto__'), false);
  assert.deepEqual(problems, ['unknown option "__proto__"', 'unknown option "constructor"']);
  assert.equal(/** @type {any} */ ({}).maxPings, undefined);
  assert.equal(/** @type {any} */ ({}).locks, undefined);
});

test('wrong types fall back per key with one problem each', () => {
  const { config, problems } = parse({
    agentTasksNeedApproval: 'false', locks: 1, lockMinutes: '5', idleMinutes: null, claimTimeoutHours: [2], maxPings: 3,
  });
  assert.deepEqual(config, { ...DEFAULTS, maxPings: 3 });
  assert.deepEqual(problems, [
    'agentTasksNeedApproval must be true or false; using true',
    'locks must be "auto", "always" or "off"; using "auto"',
    'lockMinutes must be a number; using 30',
    'idleMinutes must be a number; using 15',
    'claimTimeoutHours must be a number; using 24',
  ]);
  // 1e999 parses to Infinity, which is not a finite number
  assert.deepEqual(parseConfig('{"lockMinutes":1e999}'), { config: DEFAULTS, problems: ['lockMinutes must be a number; using 30'] });
});

test('locks is trimmed and case-insensitive; other words fall back', () => {
  assert.equal(parse({ locks: 'Off' }).config.locks, 'off');
  assert.equal(parse({ locks: ' off ' }).config.locks, 'off');
  assert.equal(parse({ locks: 'ALWAYS' }).config.locks, 'always');
  assert.deepEqual(parse({ locks: 'Off' }).problems, []);
  assert.deepEqual(parse({ locks: 'sometimes' }), {
    config: DEFAULTS, problems: ['locks must be "auto", "always" or "off"; using "auto"'],
  });
});

test('numbers outside the §7 ranges are clamped to the nearest limit', () => {
  assert.deepEqual(parse({ lockMinutes: 0, idleMinutes: 5000, claimTimeoutHours: 0.5, maxPings: 1000 }), {
    config: { ...DEFAULTS, lockMinutes: 1, idleMinutes: 1440, claimTimeoutHours: 1, maxPings: 50 },
    problems: [
      'lockMinutes 0 is below 1; using 1',
      'idleMinutes 5000 is above 1440; using 1440',
      'claimTimeoutHours 0.5 is below 1; using 1',
      'maxPings 1000 is above 50; using 50',
    ],
  });
  assert.deepEqual(parse({ lockMinutes: 20000, idleMinutes: -3, claimTimeoutHours: 1e6, maxPings: -2 }).config, {
    ...DEFAULTS, lockMinutes: 10080, idleMinutes: 1, claimTimeoutHours: 8760, maxPings: 1,
  });
  assert.deepEqual(parse({ maxPings: 1e20 }).problems, ['maxPings 100000000000000000000 is above 50; using 50']);
  // the limits themselves are fine
  assert.deepEqual(parse({ lockMinutes: 1, idleMinutes: 1440, claimTimeoutHours: 1, maxPings: 50 }).problems, []);
});

test('a fractional maxPings falls back to the default', () => {
  assert.deepEqual(parse({ maxPings: 2.5 }), { config: DEFAULTS, problems: ['maxPings must be a whole number; using 8'] });
  assert.deepEqual(parse({ maxPings: 1e-300 }).config, DEFAULTS);
});

test('problems quote no file content except an unknown key name, truncated and escaped to printable ASCII', () => {
  const words = 'private-words-from-the-file';
  const cases = [`{"locks":"${words}"}`, `{"a":${words}}`, `${words}`, `{"maxPings":3 ${words}}`, '\u0001{}'];
  for (const text of cases) {
    const { problems } = parseConfig(text);
    assert.equal(problems.length, 1, text);
    assert.ok(!problems[0].includes('private-words'), problems[0]);
    assert.match(problems[0], /^[\x20-\x7e]+$/, problems[0]);
  }
  assert.deepEqual(parseConfig('\u0001{}').problems, ['not valid JSON (Unexpected character U+0001); using defaults']);
  // a right-to-left override, a line separator and an emoji in a key name cannot reorder or break the brief
  const key = ['max', 0x202e, 'Pings', 0x2028, 0x1f600].map((p) => (typeof p === 'number' ? String.fromCodePoint(p) : p)).join('');
  const { problems } = parse({ [key]: 1 });
  assert.deepEqual(problems, ['unknown option "max\\u202ePings\\u2028\\ud83d\\ude00"']);
  assert.match(problems[0], /^[\x20-\x7e]+$/);
});

test('the defaults themselves parse without problems', () => {
  assert.deepEqual(parseConfig(JSON.stringify(DEFAULTS)), { config: { ...DEFAULTS }, problems: [] });
  assert.deepEqual(parseConfig(JSON.stringify(DEFAULTS, null, 2)).problems, []);
});

test('many problems are capped so they cannot flood the brief', () => {
  const obj = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
  const { problems } = parse({ ...obj, maxPings: 3 });
  assert.equal(problems.length, 11);
  assert.equal(problems[0], 'unknown option "k0"');
  assert.equal(problems.at(-1), 'and 15 more problems');
});

test('every returned config is frozen', () => {
  const results = [
    readConfig(tempDir()), readConfig(withConfig({ maxPings: 3 })), readConfig(withConfig('{bad')),
    parseConfig('[]'), parse({ maxPings: 1000 }), parse({})];
  for (const { config } of results) assert.ok(Object.isFrozen(config));
  assert.throws(() => { /** @type {any} */ (loadConfig(tempDir())).maxPings = 99; }, TypeError);
  assert.equal(loadConfig(tempDir()).maxPings, 8);
});

test('rulesPath points at .planrelay/rules.md', () => {
  const root = tempDir();
  assert.equal(rulesPath(root), path.join(root, '.planrelay', 'rules.md'));
});
