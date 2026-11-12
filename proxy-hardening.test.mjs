import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { boot, post, uniq, jsonResponder, sleep, get } from './test-helpers.mjs';
import { readLimits, validatePrices, validateNormalization } from './lib/proxy-validation.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_LOG_LEVEL: 'error' }, seedMetrics: '{"event":"hit","model":"claude-haiku-test","coalesced":true}\n' }); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

function rawPost(route, body, headers = {}, chunked = false) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: P.port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(data) }), ...headers } }, (res) => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(parts) }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('raw mock request timed out')));
    req.on('error', reject);
    req.write(data); req.end();
  });
}

test('unsupported POST routes cannot replay a messages cache entry', async () => {
  const body = uniq();
  await post(P.port, body);
  assert.equal((await rawPost('/other', body)).status, 404);
  assert.equal(P.state.count, 1);
});

test('API version, beta and query parameters partition cache identity', async () => {
  P.setResponder((req, res, body, state) => {
    state.count++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ version: req.headers['anthropic-version'], beta: req.headers['anthropic-beta'], route: req.url }));
  });
  const body = uniq();
  const first = await rawPost('/v1/messages', body, { 'anthropic-version': 'first' });
  const second = await rawPost('/v1/messages', body, { 'anthropic-version': 'second' });
  assert.equal(JSON.parse(second.buf).version, 'second');
  assert.equal(second.headers['x-cache'], 'MISS');
  const beta = await rawPost('/v1/messages', body, { 'anthropic-version': 'second', 'anthropic-beta': 'feature' });
  assert.equal(JSON.parse(beta.buf).beta, 'feature');
  const query = await rawPost('/v1/messages?beta=true', body, { 'anthropic-version': 'second', 'anthropic-beta': 'feature' });
  assert.equal(JSON.parse(query.buf).route, '/v1/messages?beta=true');
  assert.equal(first.status, 200);
  assert.equal(P.state.count, 4);
});

test('chunked requests are reframed without hop-by-hop or proxy credentials', async () => {
  let seen;
  P.setResponder((req, res, body, state) => { state.count++; seen = req.headers; res.end('{}'); });
  const r = await rawPost('/v1/messages', uniq(), { connection: 'x-secret', 'x-secret': 'private', 'x-cache-bypass': '1', authorization: 'client-secret' }, true);
  assert.equal(r.status, 200);
  assert.equal(seen['transfer-encoding'], undefined);
  assert.equal(seen['x-secret'], undefined);
  assert.equal(seen.authorization, undefined);
  assert.equal(seen['x-cache-bypass'], undefined);
  assert.equal(seen['x-api-key'], 'test-key');
});

test('JSON null and malformed message arrays return 400 before reaching upstream', async () => {
  for (const body of ['null', '{"messages":[null]}', '{"messages":{}}', '{"model":123}', '{"model":"bad\\nmodel"}']) {
    const r = await post(P.port, body);
    assert.equal(r.status, 400);
  }
  assert.equal(P.state.count, 0);
});

test('usage accepts JSON whitespace and coalesced history survives a restart', async () => {
  assert.deepEqual(P.mod.usageFrom('{"usage":{"input_tokens": 10, "output_tokens": 5}}'), { input_tokens: 10, output_tokens: 5 });
  assert.equal(JSON.parse((await get(P.port, '/stats')).buf).coalesced, 1);
});

test('new cache bodies and metadata have private permissions and integrity checks', async () => {
  const body = uniq();
  await post(P.port, body);
  await sleep(30);
  const files = P.entries().filter(f => f.endsWith('.json'));
  const metaFile = path.join(P.dir, 'entries', files.at(-1));
  for (const file of P.entries()) assert.equal(fs.statSync(path.join(P.dir, 'entries', file)).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(P.dir, 'entries')).mode & 0o077, 0);
  assert.ok(JSON.parse(fs.readFileSync(metaFile)).bodyHash);
});

test('invalid limits and optional matching/pricing configuration fail validation', () => {
  for (const env of [{ CACHE_MAX_REQUEST_BYTES: '0' }, { CACHE_UPSTREAM_TIMEOUT_MS: 'NaN' }, { CACHE_TTL_SEC: '-1' }, { CACHE_MAX_ENTRIES: '1.2' }]) assert.throws(() => readLimits(env), /invalid CACHE_/);
  assert.equal(readLimits({}).maxResponseBytes, 33554432);
  for (const raw of [null, [], { haiku: [1] }, { haiku: [1, -2] }, { haiku: ['1', 2] }]) assert.throws(() => validatePrices(raw), /invalid prices/);
  for (const raw of [null, { suffix_turns: 0 }, { suffix_only: 'false' }, { system_strip: 'text' }, { message_strip: [42] }, { system_strip: ['['] }]) assert.throws(() => validateNormalization(raw));
  assert.equal(validateNormalization({}).suffix_turns, 3);
});

test('tampered cached bytes fail integrity validation and refetch', async () => {
  const body = uniq();
  await post(P.port, body);
  await sleep(20);
  const crypto = await import('node:crypto');
  const key = crypto.createHash('sha256').update(body.model + '\n').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.bin'), 'partial bytes');
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 2);
  assert.equal(JSON.parse(r.buf).ok, true);
});

test('invalid optional configuration emits safe diagnostics and retains built-in behavior', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-config-'));
  const dir = path.join(temp, '.llm-cache-a');
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'normalize.json'), '{"system_strip":"synthetic-private-marker"}');
    fs.writeFileSync(path.join(dir, 'prices.json'), '{"haiku":[-1,0]}');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(new URL('./proxy-a.mjs', import.meta.url).href)}); console.log(JSON.stringify(m.priceFor('haiku')));`], {
      env: { HOME: temp, CACHE_LOG_LEVEL: 'error', CACHE_LOG_FILE: 'none' }, encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONFIG_INVALID prices.json/);
    assert.match(result.stdout, /CONFIG_INVALID normalize.json/);
    assert.match(result.stdout, /\[8e-7,0.000004\]/);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-marker/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('failed cache persistence preserves the live response and logs a safe error', async () => {
  const entries = path.join(P.dir, 'entries');
  const saved = path.join(P.dir, 'entries-saved');
  fs.renameSync(entries, saved);
  fs.writeFileSync(entries, 'not a directory');
  try {
    const r = await post(P.port, uniq());
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.buf).ok, true);
    const logFile = path.join(P.dir, 'proxy.log');
    for (let i = 0; i < 100 && (!fs.existsSync(logFile) || !fs.readFileSync(logFile, 'utf8').includes('CACHE_WRITE_FAILED')); i++) await sleep(5);
    assert.match(fs.readFileSync(logFile, 'utf8'), /CACHE_WRITE_FAILED response forwarded without caching/);
    const rows = fs.readFileSync(path.join(P.dir, 'metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.at(-1).cached, false);
  } finally { fs.rmSync(entries); fs.renameSync(saved, entries); }
});

test('gzip representation headers survive both coalesced and disk replay', async () => {
  const payload = '{"content":[{"text":"byte exact"}]}';
  const compressed = gzipSync(payload);
  P.setResponder((req, res, body, state) => {
    state.count++;
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(compressed); }, 20);
  });
  const body = uniq();
  const rs = await Promise.all([post(P.port, body), post(P.port, body)]);
  rs.push(await post(P.port, body));
  assert.deepEqual(rs.map(r => r.xcache).sort(), ['HIT', 'HIT-COALESCED', 'MISS']);
  for (const r of rs) {
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.ok(r.buf.equals(compressed));
    assert.equal(gunzipSync(r.buf).toString(), payload);
  }
  assert.equal(P.state.count, 1);
});

function seedEntry(body, meta) {
  const key = crypto.createHash('sha256').update(body.model + '\n').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.bin'), '{"stale":true}');
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.json'), JSON.stringify(meta));
}

test('missing or invalid metadata fields cannot bypass expiry or poison hit accounting', async () => {
  for (const invalid of [{}, { ts: 'now' }, { ts: -1 }, { ts: Date.now() + 100000 }, { ts: Date.now(), usage: { input_tokens: '1' } }, { ts: Date.now(), bodyHash: 'invalid' }, { ts: Date.now(), model: 123 }, { ts: Date.now(), contentEncoding: ['gzip'] }]) {
    const body = uniq();
    seedEntry(body, invalid);
    const r = await post(P.port, body);
    assert.equal(r.xcache, 'MISS');
    assert.equal(JSON.parse(r.buf).ok, true);
  }
});

test('invalid cached HTTP header values miss promptly instead of hanging the client', async () => {
  const body = uniq();
  seedEntry(body, { ts: Date.now(), contentType: 'application/json\r\nx-injected: yes' });
  const r = await rawPost('/v1/messages', body);
  assert.equal(r.headers['x-cache'], 'MISS');
  assert.equal(JSON.parse(r.buf).ok, true);
});
