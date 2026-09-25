// CACHE_OFF=1 disables caching entirely (statsObj 'off' branch + cacheOff bypass).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, get, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_OFF: 1 } }); });
after(() => P.close());

test('CACHE_OFF reports cache:off and never caches', async () => {
  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  assert.equal(s.cache, 'off');

  const body = uniq();
  assert.equal((await post(P.port, body)).xcache, 'MISS');
  await sleep(60);
  assert.equal((await post(P.port, body)).xcache, 'MISS');   // still a miss, nothing cached
  assert.equal(P.state.count, 2);
  assert.equal(P.entries().length, 0);
});
