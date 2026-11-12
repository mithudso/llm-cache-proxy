import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { boot, post, uniq, jsonResponder, get, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_MAX_REQUEST_BYTES: 512, CACHE_MAX_RESPONSE_BYTES: 1024, CACHE_MAX_MONITORS: 1 } }); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

test('oversized request bodies return 413 without an upstream call', async () => {
  const r = await post(P.port, uniq({ messages: [{ role: 'user', content: 'x'.repeat(1024) }] }));
  assert.equal(r.status, 413);
  assert.equal(P.state.count, 0);
  assert.equal((await get(P.port, '/health')).status, 200);
});

test('bypassed responses never claim to have been stored', async () => {
  await post(P.port, uniq(), { 'x-cache-bypass': '1' });
  await sleep(20);
  const rows = fs.readFileSync(path.join(P.dir, 'metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.at(-1).cached, false);
  assert.equal(P.entries().length, 0);
});

test('oversized responses stream intact and skip cache retention', async () => {
  const payload = 'x'.repeat(4096);
  P.setResponder((req, res, body, state) => { state.count++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end(payload); });
  const body = uniq();
  const rs = await Promise.all([post(P.port, body), post(P.port, body)]);
  assert.ok(rs.every(r => r.buf.toString() === payload && r.xcache === 'MISS'));
  assert.equal(P.state.count, 2);
  assert.equal((await post(P.port, body)).buf.toString(), payload);
  assert.equal(P.entries().length, 0);
});

test('oversized legacy cache files are ignored before reading their bodies', async () => {
  const body = uniq();
  const key = crypto.createHash('sha256').update(body.model + '\n').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.bin'), 'x'.repeat(2048));
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.json'), JSON.stringify({ ts: Date.now(), model: body.model }));
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(JSON.parse(r.buf).ok, true);
  assert.equal(P.state.count, 1);
});

test('monitor connections are bounded', async () => {
  const open = () => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: P.port, path: '/monitor' }, res => resolve({ req, res }));
    req.on('error', reject);
  });
  const first = await open();
  first.res.resume();
  try {
    const second = await open();
    assert.equal(second.res.statusCode, 503);
    second.res.resume();
    second.req.destroy();
  } finally { first.req.destroy(); }
});

test('disconnected oversized-response waiters never start an extra upstream call', async () => {
  let began, release;
  const started = new Promise(resolve => { began = resolve; });
  const payload = 'x'.repeat(4096);
  P.setResponder((req, res, body, state) => {
    state.count++;
    if (state.count === 1) { release = () => res.end(payload); began(); }
    else res.end(payload);
  });
  const body = uniq();
  const leader = post(P.port, body);
  await started;
  const waiter = http.request({ host: '127.0.0.1', port: P.port, path: '/v1/messages', method: 'POST' });
  waiter.on('error', () => {});
  waiter.end(JSON.stringify(body));
  await sleep(20);
  waiter.destroy();
  await sleep(20);
  release();
  assert.equal((await leader).buf.toString(), payload);
  await sleep(30);
  assert.equal(P.state.count, 1);
});
