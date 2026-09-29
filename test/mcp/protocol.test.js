import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHandler, serveStdio, SUPPORTED_VERSIONS } from '../../src/mcp/protocol.js';
import { BoardError } from '../../src/core/ops.js';

const errors = [];
const handle = createHandler({
  name: 'agentboard',
  version: '0.1.0',
  instructions: 'Be nice.',
  onError: (err, context) => errors.push([context, err.message]),
  tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, handler: (a) => `echo ${a.x}` },
    { name: 'refuse', description: 'Refuse', inputSchema: { type: 'object' }, handler: () => { throw new BoardError('No, and here is why.'); } },
    { name: 'crash', description: 'Crash', inputSchema: { type: 'object' }, handler: () => { throw new Error('EBUSY: C:\\secret\\path'); } },
  ],
});
const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates the protocol version', () => {
  const r = handle(req(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.deepEqual(r.result.serverInfo, { name: 'agentboard', version: '0.1.0' });
  assert.equal(r.result.instructions, 'Be nice.');
  // a newer client (or none given) is offered the newest version this server speaks
  assert.equal(handle(req(2, 'initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, SUPPORTED_VERSIONS[0]);
  assert.equal(handle(req(3, 'initialize')).result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('notifications get no response; ping and tools/list work', () => {
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.deepEqual(handle(req(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  const tools = handle(req(4, 'tools/list')).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'refuse', 'crash']);
  assert.equal('handler' in tools[0], false);
});

test('tools/call returns text, BoardErrors as tool errors, and hides internals', () => {
  assert.deepEqual(handle(req(5, 'tools/call', { name: 'echo', arguments: { x: 1 } })).result, { content: [{ type: 'text', text: 'echo 1' }] });
  assert.deepEqual(handle(req(6, 'tools/call', { name: 'refuse', arguments: {} })).result, {
    content: [{ type: 'text', text: 'No, and here is why.' }], isError: true,
  });
  errors.length = 0;
  const crash = handle(req(7, 'tools/call', { name: 'crash' })).result;
  assert.equal(crash.isError, true);
  assert.equal(crash.content[0].text, 'Internal error in agentboard. Try again; if it keeps failing, tell the human.');
  assert.deepEqual(errors, [['tool crash', 'EBUSY: C:\\secret\\path']]);
  assert.equal(handle(req(8, 'tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal(handle(req(9, 'tools/call')).error.code, -32602);
  assert.equal(handle(req(10, 'resources/list')).error.code, -32601);
});

test('malformed messages get JSON-RPC errors; responses sent to the server are ignored', () => {
  for (const bad of [null, 7, 'ping', { id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 42 }]) {
    const r = handle(bad);
    assert.equal(r.error.code, -32600, JSON.stringify(bad));
    assert.equal(r.id, bad?.id ?? null);
  }
  assert.equal(handle({ jsonrpc: '2.0', id: 3, result: {} }), null);
  assert.equal(handle({ jsonrpc: '2.0', id: 4, error: { code: 1, message: 'x' } }), null);
});

/** Feeds `lines` to serveStdio and returns the parsed responses. */
async function serve(h, lines, onError) {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = [];
  output.on('data', (chunk) => out.push(...chunk.toString().split('\n').filter(Boolean)));
  const rl = serveStdio(h, { input, output, onError });
  const closed = new Promise((resolve) => rl.on('close', resolve));
  for (const line of lines) input.write(line);
  input.end();
  await closed;
  await new Promise((resolve) => setImmediate(resolve));
  return out.map((l) => JSON.parse(l));
}

test('serveStdio speaks newline-delimited JSON and never stops on bad input', async () => {
  const responses = await serve(handle, [
    JSON.stringify(req(1, 'ping')) + '\n',
    '{not json\n',
    '\n',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\r\n',
    JSON.stringify([req(2, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(3, 'ping')]) + '\n',
    '[]\n',
    JSON.stringify(req(4, 'tools/call', { name: 'echo', arguments: { x: 'caf\u00e9' } })).slice(0, 30),
    JSON.stringify(req(4, 'tools/call', { name: 'echo', arguments: { x: 'caf\u00e9' } })).slice(30) + '\n',
  ]);
  assert.deepEqual(responses, [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    [{ jsonrpc: '2.0', id: 2, result: {} }, { jsonrpc: '2.0', id: 3, result: {} }],
    { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
    { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'echo caf\u00e9' }] } },
  ]);
});

test('serveStdio answers a request whose handling throws with an internal error, and reports it', async () => {
  const seen = [];
  const throwing = () => { throw new Error('bug'); };
  const responses = await serve(throwing, [JSON.stringify(req(1, 'ping')) + '\n', JSON.stringify({ jsonrpc: '2.0', method: 'x' }) + '\n'], (err) => seen.push(err.message));
  assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Internal error' } }]);
  assert.deepEqual(seen, ['bug', 'bug']);
});
