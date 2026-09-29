import readline from 'node:readline';

/**
 * A minimal MCP server (§3): JSON-RPC 2.0 over newline-delimited stdio, with `initialize`, `ping`,
 * `tools/list` and `tools/call`. No dependencies. It never stops on bad input: a line that is not
 * JSON gets a parse error, a message that is not a request gets an invalid-request error, and a
 * request whose handling throws gets an internal error.
 */

/** Protocol versions this server speaks, newest first. */
export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A usable JSON-RPC id: a string or a number. */
const isId = (v) => typeof v === 'string' || typeof v === 'number';

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: isId(id) ? id : null, error: { code, message } };
}

/**
 * @typedef {{ name: string, description: string, inputSchema: object, handler: (args: any) => string }} Tool
 * @param {{ name: string, version: string, instructions?: string, tools: Tool[],
 *   onError?: (err: unknown, context: string) => void }} spec
 *   onError: told about every failure that is not a BoardError (the agent sees only a short message)
 * @returns {(msg: unknown) => object | null} the response, or null when there is none to send
 */
export function createHandler(spec) {
  const byName = new Map(spec.tools.map((t) => [t.name, t]));
  const listed = spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const onError = spec.onError ?? (() => {});
  const internal = `Internal error in ${spec.name}. Try again; if it keeps failing, tell the human.`;

  function callTool(params) {
    const name = isObj(params) ? params.name : undefined;
    const tool = typeof name === 'string' ? byName.get(name) : undefined;
    if (!tool) return { error: [-32602, `Unknown tool: ${String(name).slice(0, 100)}`] };
    try {
      return { result: { content: [{ type: 'text', text: tool.handler(params.arguments ?? {}) }] } };
    } catch (err) {
      // a refusal meant for the agent (§16); anything else is a bug or an IO failure, logged but not shown
      if (/** @type {any} */ (err)?.name === 'BoardError') return { result: { content: [{ type: 'text', text: err.message }], isError: true } };
      onError(err, `tool ${name}`);
      return { result: { content: [{ type: 'text', text: internal }], isError: true } };
    }
  }

  return function handle(msg) {
    if (!isObj(msg)) return rpcError(null, -32600, 'Invalid request');
    // a response to a request of ours: this server sends none, so there is nothing to do
    if (msg.method === undefined && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) return null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg.id, -32600, 'Invalid request');
    if (msg.id === undefined) return null; // a notification: never answered
    const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = isObj(msg.params) ? msg.params.protocolVersion : undefined;
        return ok({
          // the client's version when this server speaks it, else the newest one it does (the client decides)
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: spec.name, version: spec.version },
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: listed });
      case 'tools/call': {
        const { result, error } = callTool(msg.params);
        return error ? rpcError(msg.id, ...error) : ok(result);
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method.slice(0, 100)}`);
    }
  };
}

/**
 * Serves `handle` over newline-delimited JSON (one message per line, batches accepted). Nothing
 * else may be written to `output`. Returns the readline interface, which closes when input ends.
 * @param {(msg: unknown) => object | null} handle
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, onError?: (err: unknown, context: string) => void }} [io]
 */
export function serveStdio(handle, { input = process.stdin, output = process.stdout, onError = () => {} } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  // a client that went away (EPIPE) must not crash the process; input ends right after
  output.on('error', (err) => onError(err, 'output'));
  const send = (obj) => output.write(`${JSON.stringify(obj)}\n`);
  const answer = (m) => {
    try {
      return handle(m);
    } catch (err) {
      onError(err, 'request');
      return isObj(m) && m.id !== undefined && m.method !== undefined ? rpcError(m.id, -32603, 'Internal error') : null;
    }
  };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send(rpcError(null, -32700, 'Parse error'));
      return;
    }
    if (!Array.isArray(msg)) {
      const r = answer(msg);
      if (r) send(r);
      return;
    }
    if (!msg.length) {
      send(rpcError(null, -32600, 'Invalid request'));
      return;
    }
    const responses = msg.map(answer).filter(Boolean);
    if (responses.length) send(responses);
  });
  return rl;
}
