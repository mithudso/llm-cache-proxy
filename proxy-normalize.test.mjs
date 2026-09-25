// Normalized-key cache (HIT-NORM): strips dynamic fields per normalize.json before hashing.
// normalize.json present + suffix_only:false → tier-2 key; suffix_only:true tested in proxy-suffix.test.mjs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, get, uniq, sleep, jsonResponder } from './test-helpers.mjs';

const NORM = {
  system_strip:  ['Current date: [^\\n]*', 'Session-ID: [a-f0-9-]+'],
  message_strip: ['<tool_result>[\\s\\S]*?</tool_result>'],
  suffix_only:   false,
  suffix_turns:  3,
};

let P;
before(async () => { P = await boot({ seedNormalize: NORM }); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

test('HIT-NORM: same logical request, different dynamic system field', async () => {
  const base = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'what is gold?' }] };
  const body1 = { ...base, system: 'Current date: 2026-01-01\nYou are helpful.' };
  const body2 = { ...base, system: 'Current date: 2026-06-24\nYou are helpful.' };

  // First request: exact MISS — also writes alias under the normalized key
  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  assert.equal(P.state.count, 1);

  await sleep(60);

  // Second request: different timestamp → different exact key, same normalized key → HIT-NORM
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-NORM');
  assert.equal(P.state.count, 1);        // no second upstream call
  assert.ok(a.buf.equals(b.buf));        // byte-identical replay
});

test('normKey === key: patterns do not match this body → exact miss, normal HIT on repeat', async () => {
  // body has no system field and no message content matching patterns → normalizeBody is a no-op
  // → nk === key → aliasKeys is empty → normal MISS/HIT behaviour, no norm alias
  const body = uniq();
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
  await sleep(60);
  const r2 = await post(P.port, body);
  assert.equal(r2.xcache, 'HIT');        // plain HIT, not HIT-NORM
  assert.equal(P.state.count, 1);
});

test('system field absent: normalizeBody skips system strip (typeof system !== string)', async () => {
  const body = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'no-sys' }] };
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
});

test('message_strip: HIT-NORM when tool_result content differs between calls', async () => {
  const makeBody = (result) => ({
    model: 'claude-haiku-test', max_tokens: 8,
    system: 'You are helpful.',
    messages: [{ role: 'user', content: `Context: <tool_result>${result}</tool_result>\nWhat is silver?` }],
  });
  const body1 = makeBody('{"price":25}');
  const body2 = makeBody('{"price":26}');

  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  assert.equal(P.state.count, 1);
  await sleep(60);
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-NORM');
  assert.equal(P.state.count, 1);
  assert.ok(a.buf.equals(b.buf));
});

test('message content unchanged after strip: original msg returned (c === msg.content branch)', async () => {
  // message content does not match message_strip patterns → no change → return msg unchanged
  // system has dynamic field so normKey != key → alias is still written
  const body1 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: 'Current date: 2026-01-01\nStatic.',
    messages: [{ role: 'user', content: 'no tool result here' }],
  };
  const body2 = { ...body1, system: 'Current date: 2026-06-24\nStatic.' };
  await post(P.port, body1);
  await sleep(60);
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-NORM');
  assert.equal(P.state.count, 1);
});

test('non-string message content: returned unchanged (array content blocks)', async () => {
  // content is an array → typeof msg.content !== 'string' → msg returned as-is
  const body1 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: 'Current date: 2026-01-01\nAssist.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is copper?' }] }],
  };
  const body2 = { ...body1, system: 'Current date: 2026-06-24\nAssist.' };
  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  await sleep(60);
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-NORM');
  assert.equal(P.state.count, 1);
  assert.ok(a.buf.equals(b.buf));
});

test('messages field absent: Array.isArray(messages) false branch → system strip still normalizes', async () => {
  // body with no messages field → Array.isArray(undefined) = false → skip message normalization
  // system field still matches pattern → normKey ≠ key → alias written → HIT-NORM on second call
  const body1 = { model: 'claude-haiku-test', max_tokens: 8, system: 'Current date: 2026-01-01\nNo msgs.' };
  const body2 = { model: 'claude-haiku-test', max_tokens: 8, system: 'Current date: 2026-06-24\nNo msgs.' };
  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  await sleep(60);
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-NORM');
  assert.equal(P.state.count, 1);
});

test('HIT-NORM increments hits in /stats', async () => {
  const body1 = { model: 'claude-haiku-test', max_tokens: 8, system: 'Current date: 2000-01-01\nX.', messages: [{ role: 'user', content: 'stats-test' }] };
  const body2 = { ...body1, system: 'Current date: 2026-01-01\nX.' };
  const s0 = JSON.parse((await get(P.port, '/stats')).buf.toString());
  await post(P.port, body1);
  await sleep(60);
  await post(P.port, body2);
  const s1 = JSON.parse((await get(P.port, '/stats')).buf.toString());
  assert.ok(s1.hits > s0.hits);
});
