// prices.json present at boot -> the import-time Object.assign override runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, get, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ seedPrices: { haiku: [1e-3, 2e-3] } }); });
after(() => P.close());

test('prices.json overrides the built-in pricing table', async () => {
  await post(P.port, uniq({ model: 'claude-haiku-test' }));   // in 10 / out 5
  await sleep(60);   // MISS accounting settles after the response's async cache write
  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  // 10*1e-3 + 5*2e-3 = 0.02 with the override (vs ~3e-5 with defaults)
  assert.ok(s.usd_spent > 0.01, `override applied (usd_spent=${s.usd_spent})`);
});
