// Counters seed from metrics.jsonl on boot (hit/miss/error/skip branches).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, get, post, uniq, sleep } from './test-helpers.mjs';

const seedMetrics = [
  '{"event":"hit","model":"claude-haiku","in":1000000,"out":500000}',
  '{"event":"hit","model":"claude-haiku"}',   // no in/out -> exercises the `|| 0` default
  '',                       // blank line -> skipped
  'not-json',              // malformed -> caught and skipped
  '{"event":"miss","model":"claude-opus","in":3,"out":2}',
  '{"event":"miss","model":"claude-opus"}',   // no in/out -> exercises the `|| 0` default
  '{"event":"error"}',
  '{"event":"other"}',     // unknown event -> ignored
].join('\n') + '\n';

let P;
before(async () => { P = await boot({ seedMetrics }); });
after(() => P.close());

test('seed() replays prior metrics into the counters', async () => {
  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 2);
  assert.equal(s.errors, 1);
  assert.equal(s.calls, 5);
  assert.ok(s.tokens_saved >= 1500000);
  assert.ok(s.usd_saved > 0);   // large seeded tokens -> non-zero after rounding

  // before any live traffic, the session view is all zeros (baseline frozen after seed)
  assert.equal(s.session.calls, 0);
  assert.equal(s.session.hits, 0);
  assert.equal(s.session.misses, 0);
});

test('session stats count only this process; all-time includes the seeded history', async () => {
  await post(P.port, uniq());       // one live MISS through the proxy
  await sleep(60);                   // let the post-response accounting settle
  const s = JSON.parse((await get(P.port, '/stats')).buf.toString());
  // all-time = seeded (5 calls: 2 hit / 2 miss / 1 error) + this live miss
  assert.equal(s.calls, 6);
  assert.equal(s.misses, 3);
  // this session = only the live miss
  assert.equal(s.session.calls, 1);
  assert.equal(s.session.misses, 1);
  assert.equal(s.session.hits, 0);
  assert.equal(s.session.errors, 0);
  assert.ok(s.session.usd_spent >= 0);
});
