// Minimal normalize.json {} — no system_strip, message_strip, or suffix_turns fields.
// Covers the || [] and ?? 3 fallback branches in NORM_PATTERNS loading.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, sleep } from './test-helpers.mjs';

let P;
// Empty object: all fields absent → system_strip||[], message_strip||[], suffix_turns??3 all use right side
before(async () => { P = await boot({ seedNormalize: {} }); });
after(() => P.close());

test('|| [] and ?? 3 defaults: empty normalize.json loads and is a no-op', async () => {
  // With {} config: system_strip || [] = [], message_strip || [] = [], suffix_turns ?? 3 = 3
  // normalizeBody is a no-op → nk === key → no alias → normal MISS/HIT
  const body = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'defaults-ok' }] };
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  await sleep(60);
  const r2 = await post(P.port, body);
  assert.equal(r2.xcache, 'HIT');   // plain HIT — no alias written (nk === key)
  assert.equal(P.state.count, 1);
});
