// Default-config scenarios against one shared proxy instance.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { boot, post, get, request, jsonResponder, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot(); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

const keyOf = (body) => {
  const raw = Buffer.from(JSON.stringify(body));
  return crypto.createHash('sha256').update((body.model || '') + '\n').update(raw).digest('hex');
};

test('GET endpoints and non-POST routing', async () => {
  const h = await get(P.port, '/health');
  assert.equal(h.status, 200);
  assert.equal(h.buf.toString(), '{"status":"ok"}');

  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  assert.equal(s.cache, 'on');
  assert.equal(s.calls, 0);          // fresh instance, before any traffic
  assert.equal(s.hit_rate_pct, 0);   // hitRate() zero-calls branch
  assert.equal(s.savings_pct, 0);    // statsObj zero-dollars branch

  const m = (await get(P.port, '/metrics')).buf.toString();
  assert.match(m, /llm_cache_calls_total 0/);
  assert.match(m, /llm_cache_usd_spent_total/);

  assert.equal((await request(P.port, 'DELETE', '/v1/messages')).status, 404);
  assert.equal((await get(P.port, '/nope')).status, 404);
});

test('MISS then HIT: byte-identical replay, no second upstream call', async () => {
  const body = uniq();
  const a = await post(P.port, body);
  assert.equal(a.status, 200);
  assert.equal(a.xcache, 'MISS');
  assert.equal(P.state.count, 1);
  await sleep(60);
  const b = await post(P.port, body);
  assert.equal(b.xcache, 'HIT');
  assert.equal(P.state.count, 1);             // no second upstream call
  assert.ok(a.buf.equals(b.buf));

  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  assert.ok(s.tokens_saved > 0);
  assert.ok(s.savings_pct > 0);               // statsObj non-zero-dollars branch
});

test('streaming SSE: complete stream (message_stop) is cached and replayed', async () => {
  const sse = 'event: message_start\n\nevent: content_block_delta\n\n"output_tokens":4\nevent: message_stop\ndata: {}\n\n';
  P.setResponder((req, res, b, st) => { st.count++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse); });
  const body = uniq({ stream: true });
  const a = await post(P.port, body);
  assert.equal(a.xcache, 'MISS');
  assert.match(a.headers['content-type'], /event-stream/);
  await sleep(60);
  const b = await post(P.port, body);
  assert.equal(b.xcache, 'HIT');
  assert.equal(P.state.count, 1);
  assert.ok(a.buf.equals(b.buf));
});

test('multi-chunk SSE: live MISS reassembles in order; HIT replays byte-identical across chunk boundaries', async () => {
  // split deliberately mid-token ("he|llo") so the test fails if concatenation drops/reorders bytes
  const c1 = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const c2 = 'event: content_block_delta\ndata: {"partial":"he';
  const c3 = 'llo"}\n\nevent: message_stop\ndata: {}\n\n';
  const full = c1 + c2 + c3;
  P.setResponder((req, res, b, st) => {
    st.count++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(c1);
    setTimeout(() => { res.write(c2); setTimeout(() => res.end(c3), 15); }, 15);
  });
  const body = uniq({ stream: true });
  const a = await post(P.port, body);
  assert.equal(a.xcache, 'MISS');
  assert.equal(a.buf.toString(), full);     // live MISS streamed every chunk, in order
  await sleep(80);
  const b = await post(P.port, body);
  assert.equal(b.xcache, 'HIT');
  assert.equal(P.state.count, 1);
  assert.ok(a.buf.equals(b.buf));            // byte-identical replay
  assert.equal(b.buf.toString(), full);      // including the bytes that spanned a chunk boundary
});

test('streaming without message_stop is NOT cached (incomplete)', async () => {
  P.setResponder((req, res, b, st) => { st.count++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\n\n"output_tokens":2\n'); });
  const body = uniq({ stream: true });
  assert.equal((await post(P.port, body)).xcache, 'MISS');
  await sleep(60);
  assert.equal((await post(P.port, body)).xcache, 'MISS');   // refetched, not cached
  assert.equal(P.state.count, 2);
});

test('non-200 upstream is forwarded and not cached', async () => {
  P.setResponder((req, res, b, st) => { st.count++; res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"bad"}'); });
  const body = uniq();
  const a = await post(P.port, body);
  assert.equal(a.status, 400);
  assert.equal(a.xcache, 'MISS');
  await sleep(60);
  assert.equal((await post(P.port, body)).status, 400);
  assert.equal(P.state.count, 2);
});

test('x-cache-bypass header forwards and skips the cache', async () => {
  const body = uniq();
  await post(P.port, body);            // warm
  await sleep(60);
  const b = await post(P.port, body, { 'x-cache-bypass': '1' });
  assert.equal(b.xcache, 'MISS');
  assert.equal(P.state.count, 2);
});

test('coalescing: a burst of identical calls makes exactly ONE upstream call', async () => {
  P.setResponder((req, res, b, st) => {
    st.count++;
    // hold the upstream open long enough that the whole burst is in-flight together, even on a loaded CI runner
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, usage: { input_tokens: 7, output_tokens: 3 } })); }, 200);
  });
  const body = uniq();
  const N = 5;
  const rs = await Promise.all(Array.from({ length: N }, () => post(P.port, body)));
  assert.equal(P.state.count, 1);
  assert.equal(rs.filter((r) => r.xcache === 'MISS').length, 1);
  assert.equal(rs.filter((r) => r.xcache === 'HIT-COALESCED').length, N - 1);
  assert.ok(rs.every((r) => r.buf.equals(rs[0].buf)));
});

test('coalescing replays a non-200 result to waiters (MISS-COALESCED)', async () => {
  P.setResponder((req, res, b, st) => {
    st.count++;
    setTimeout(() => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate"}'); }, 200);   // keep the burst overlapping under CI load
  });
  const body = uniq();
  const [a, b] = await Promise.all([post(P.port, body), post(P.port, body)]);
  assert.equal(P.state.count, 1);
  assert.deepEqual([a.xcache, b.xcache].sort(), ['MISS', 'MISS-COALESCED']);
  assert.equal(a.status, 429);
  assert.equal(b.status, 429);
});

test('expired entries (TTL elapsed) are treated as a miss', async () => {
  const body = uniq();
  assert.equal((await post(P.port, body)).xcache, 'MISS');
  await sleep(60);
  // age the entry past its TTL by rewriting the meta timestamp to the epoch
  const meta = path.join(P.dir, 'entries', keyOf(body) + '.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  m.ts = 0;
  fs.writeFileSync(meta, JSON.stringify(m));
  assert.equal((await post(P.port, body)).xcache, 'MISS');   // expired -> refetched
  assert.equal(P.state.count, 2);
});

test('unknown model falls back to default pricing; absent usage -> zero tokens', async () => {
  P.setResponder((req, res, b, st) => { st.count++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await post(P.port, uniq({ model: 'mystery-model-9' }));
  // proxy stays healthy and the request completed
  assert.equal(P.state.count, 1);
  assert.equal((await get(P.port, '/health')).status, 200);
});

test('non-JSON request body is handled (empty model, still forwarded)', async () => {
  const r = await post(P.port, 'this-is-not-json', { 'content-type': 'text/plain' });
  assert.equal(r.status, 200);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
});

test('upstream with no content-type header: replayed HIT falls back to application/json', async () => {
  P.setResponder((req, res, b, st) => { st.count++; res.writeHead(200); res.end('{"ok":true}'); });
  const body = uniq();
  await post(P.port, body);            // cold MISS stores meta.contentType = fallback
  await sleep(60);
  const b = await post(P.port, body);  // warm HIT replays the stored fallback
  assert.equal(b.xcache, 'HIT');
  assert.equal(b.headers['content-type'], 'application/json');   // contentType || default
});

test('upstream connection error returns 502 ERROR', async () => {
  P.setResponder((req, res) => { res.destroy(); });   // reset the socket, no response
  const before = JSON.parse((await get(P.port, '/stats')).buf.toString()).errors;
  const r = await post(P.port, 'not-json', { 'content-type': 'text/plain' });   // empty model -> ERR log '?' branch
  assert.equal(r.status, 502);
  assert.equal(r.xcache, 'ERROR');
  assert.match(r.buf.toString(), /proxy_error/);
  const after = JSON.parse((await get(P.port, '/stats')).buf.toString()).errors;
  assert.equal(after, before + 1);
});

test('HIT on a minimal cache entry uses serveHit fallbacks (no model/contentType/usage)', async () => {
  const body = { max_tokens: 8, messages: [{ role: 'user', content: 'minimal' }] };   // no model -> key model ''
  const key = keyOf(body);
  const buf = Buffer.from('{"cached":"bytes"}');
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.bin'), buf);
  fs.writeFileSync(path.join(P.dir, 'entries', key + '.json'), JSON.stringify({ ts: Date.now(), model: '' }));
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'HIT');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');   // m.contentType || default
  assert.ok(r.buf.equals(buf));
  assert.equal(P.state.count, 0);                                // served from disk, no upstream
});

test('client abort tears down the upstream without crashing the proxy', async () => {
  P.setResponder((req, res, b, st) => { st.count++; setTimeout(() => { try { res.end('{}'); } catch {} }, 500); });
  const data = Buffer.from(JSON.stringify(uniq()));
  const req = (await import('node:http')).request({ host: '127.0.0.1', port: P.port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } });
  req.on('error', () => {});
  req.write(data); req.end();
  await sleep(40);
  req.destroy();                 // abort mid-flight
  await sleep(80);
  assert.equal((await get(P.port, '/health')).status, 200);
});
