import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, post, uniq, jsonResponder, get, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_UPSTREAM_TIMEOUT_MS: 250 } }); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

test('literal message_stop text is incomplete and never a HIT, including coalesced requests', async () => {
  P.setResponder((req, res, body, state) => {
    state.count++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => res.end('event: content_block_delta\ndata: {"text":"message_stop"}\n\n'), 25);
  });
  const body = uniq({ stream: true });
  const rs = await Promise.all([post(P.port, body), post(P.port, body)]);
  assert.deepEqual(rs.map(r => r.xcache).sort(), ['MISS', 'MISS-COALESCED']);
  assert.equal((await post(P.port, body)).xcache, 'MISS');
  assert.equal(P.state.count, 2);
});

test('upstream deadline settles all coalesced waiters without refetching', { timeout: 1000 }, async () => {
  P.setResponder((req, res, body, state) => { state.count++; });
  const body = uniq();
  const rs = await Promise.all([post(P.port, body), post(P.port, body)]);
  assert.ok(rs.every(r => r.status === 504));
  assert.equal(P.state.count, 1);
  assert.equal((await get(P.port, '/health')).status, 200);
});

test('interrupted upstream response closes the client and releases inflight state', { timeout: 1000 }, async () => {
  P.setResponder((req, res, body, state) => {
    state.count++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\n\n'); setTimeout(() => res.destroy(), 10);
  });
  const body = uniq({ stream: true });
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: P.port, path: '/v1/messages', method: 'POST' }, res => {
      res.resume(); res.on('aborted', resolve); res.on('error', resolve); res.on('end', () => reject(new Error('truncated response ended successfully')));
    });
    req.on('error', resolve); req.end(JSON.stringify(body));
  });
  await sleep(10);
  P.setResponder(jsonResponder);
  assert.equal((await post(P.port, body)).xcache, 'MISS');
});

test('coalesced rate limits retain Retry-After headers', async () => {
  P.setResponder((req, res, body, state) => {
    state.count++; setTimeout(() => { res.writeHead(429, { 'retry-after': '17', 'content-type': 'application/json' }); res.end('{}'); }, 20);
  });
  const body = uniq();
  const rs = await Promise.all([post(P.port, body), post(P.port, body)]);
  assert.ok(rs.every(r => r.headers['retry-after'] === '17'));
  assert.equal(P.state.count, 1);
});

test('a terminal-looking frame followed by an incomplete/error frame is not cached', async () => {
  for (const tail of ['event: error\ndata: {}\n\n', 'event: error\ndata: {}']) {
    P.setResponder((req, res, body, state) => {
      state.count++; res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_stop\ndata: {}\n\n' + tail);
    });
    const body = uniq({ stream: true });
    await post(P.port, body);
    assert.equal((await post(P.port, body)).xcache, 'MISS');
  }
});

test('a disconnected leader does not abort an upstream response needed by a waiter', async () => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  P.setResponder((req, res, body, state) => {
    state.count++;
    release = () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); };
    began();
  });
  const body = uniq();
  const leader = http.request({ host: '127.0.0.1', port: P.port, path: '/v1/messages', method: 'POST' });
  leader.on('error', () => {});
  leader.end(JSON.stringify(body));
  await started;
  const waiter = post(P.port, body);
  await sleep(15);
  leader.destroy();
  await sleep(10);
  release();
  const result = await waiter;
  assert.equal(result.status, 200);
  assert.equal(result.xcache, 'HIT-COALESCED');
  assert.equal(JSON.parse(result.buf).ok, true);
  assert.equal(P.state.count, 1);
});
