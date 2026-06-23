// CACHE_MAX_ENTRIES=1 forces the throttled LRU prune to run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_MAX_ENTRIES: 1 } }); });
after(() => P.close());

test('LRU prune keeps the cache at or under CACHE_MAX_ENTRIES', async () => {
  // three distinct cached misses; each write bumps the count past the cap and prunes
  for (let i = 0; i < 3; i++) { await post(P.port, uniq()); await sleep(90); }
  await sleep(150);
  const bins = P.entries().filter((f) => f.endsWith('.bin'));
  assert.ok(bins.length <= 1, `pruned to <=1 .bin (got ${bins.length})`);
});
