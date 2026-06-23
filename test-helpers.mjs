// Shared harness for the proxy unit/integration suite (NOT a test file itself).
// Each *.test.mjs runs in its own node:test child process, imports proxy-a.mjs
// once, and points it at a local HTTP mock via the CACHE_UPSTREAM_* env hooks.
// No network, no real key, deterministic — coverage merges across the child
// processes. (test-fidelity.mjs is the separate live, paid, byte-exact check.)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
export const uniq = (extra = {}) =>
  ({ model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'q' + (n++) }], ...extra });

// default upstream: a complete 200 JSON response carrying usage
export function jsonResponder(req, res, body, state) {
  state.count++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 5 } }));
}

function mockUpstream(state) {
  return http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => state.responder(req, res, Buffer.concat(parts), state));
  });
}
const listen = (srv, port = 0) =>
  new Promise((resolve) => srv.listen(port, () => resolve(srv.address().port)));

// Boot one isolated proxy + mock upstream. Call once per test file; swap the
// mock's behavior between tests with setResponder(). env/seed* must be applied
// before the dynamic import because proxy-a.mjs reads them at module top-level.
export async function boot({ responder = jsonResponder, env = {}, quiet = true, seedMetrics, seedPrices } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-'));
  const dir = path.join(home, '.llm-cache-a');
  fs.mkdirSync(dir, { recursive: true });
  if (seedMetrics !== undefined) fs.writeFileSync(path.join(dir, 'metrics.jsonl'), seedMetrics);
  if (seedPrices !== undefined) fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify(seedPrices));

  const state = { count: 0, responder };
  const mock = mockUpstream(state);
  const upPort = await listen(mock);

  process.env.HOME = home;
  process.env.ANTHROPIC_API_KEY_REAL = 'test-key';
  process.env.CACHE_UPSTREAM_PROTO = 'http';
  process.env.CACHE_UPSTREAM_HOST = '127.0.0.1';
  process.env.CACHE_UPSTREAM_PORT = String(upPort);
  if (quiet) process.env.CACHE_QUIET = '1'; else delete process.env.CACHE_QUIET;
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  const mod = await import('./proxy-a.mjs');
  const server = mod.start(0);
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  return {
    port, home, dir, state, mod, server, mock,
    setResponder(fn) { state.responder = fn; },
    resetCount() { state.count = 0; },
    entries() { return fs.readdirSync(path.join(dir, 'entries')); },
    async close() {
      await new Promise((r) => server.close(r));
      await new Promise((r) => mock.close(r));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.isBuffer(body) ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, ...headers } },
      (r) => { const p = []; r.on('data', (c) => p.push(c)); r.on('end', () =>
        resolve({ status: r.statusCode, xcache: r.headers['x-cache'], buf: Buffer.concat(p), headers: r.headers })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

export function request(port, method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method },
      (r) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () =>
        resolve({ status: r.statusCode, buf: Buffer.concat(b), headers: r.headers })); });
    req.on('error', reject); req.end();
  });
}
export const get = (port, p) => request(port, 'GET', p);
