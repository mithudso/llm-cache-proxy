// Non-loopback bind WITH an auth token: binds all interfaces, enforces x-cache-auth.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, get, uniq } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_HOST: '0.0.0.0', CACHE_AUTH_TOKEN: 'secret' } }); });
after(() => P.close());

test('/health stays open without the token', async () => {
  assert.equal((await get(P.port, '/health')).status, 200);   // exempt: liveness probes must work
});

test('requests without a valid token are rejected (401)', async () => {
  const r = await post(P.port, uniq());                        // no x-cache-auth header
  assert.equal(r.status, 401);
  assert.match(r.buf.toString(), /unauthorized/);
  assert.equal(P.state.count, 0);                              // never reached the upstream
});

test('requests with the correct token pass through', async () => {
  const r = await post(P.port, uniq(), { 'x-cache-auth': 'secret' });
  assert.equal(r.status, 200);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
});

test('/stats also requires the token', async () => {
  assert.equal((await get(P.port, '/stats')).status, 401);
});
