// Not-quiet boot exercises the log() write path and the start() banner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, get, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ quiet: false }); });
after(() => P.close());

test('logging path runs when CACHE_QUIET is unset', async () => {
  const body = uniq();
  assert.equal((await post(P.port, body)).xcache, 'MISS');   // MISS log line
  await sleep(60);
  assert.equal((await post(P.port, body)).xcache, 'HIT');    // HIT log line
});
