// Suffix-key cache (HIT-SUFFIX): suffix_only:true keys on last N messages, ignoring history prefix.
// Covers: sufKey computed, sk===nk dedup, HIT-SUFFIX, suffix miss, byte-exact replay.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, post, sleep, jsonResponder } from './test-helpers.mjs';

const NORM = {
  system_strip:  [],
  message_strip: [],
  suffix_only:   true,
  suffix_turns:  2,
};

let P;
before(async () => { P = await boot({ seedNormalize: NORM }); });
after(() => P.close());
beforeEach(() => { P.setResponder(jsonResponder); P.resetCount(); });

test('HIT-SUFFIX: same last 2 messages, different conversation prefix', async () => {
  const shared = [
    { role: 'user',      content: 'What is titanium?' },
    { role: 'assistant', content: 'Titanium is element 22.' },
  ];
  // body1: 3 messages — prefix A + shared suffix
  const body1 = {
    model: 'claude-haiku-test', max_tokens: 8,
    messages: [{ role: 'user', content: 'prefix-A' }, ...shared],
  };
  // body2: different prefix, same last 2 messages
  const body2 = {
    model: 'claude-haiku-test', max_tokens: 8,
    messages: [{ role: 'user', content: 'prefix-B' }, ...shared],
  };

  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  assert.equal(P.state.count, 1);
  await sleep(60);

  // exact key differs (different prefix), normKey null (nk===key, no patterns),
  // suffix key matches last 2 messages → HIT-SUFFIX
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-SUFFIX');
  assert.equal(P.state.count, 1);        // no second upstream call
  assert.ok(a.buf.equals(b.buf));        // byte-identical replay
});

test('sk === nk (messages.length <= suffix_turns): suffix alias not written, second call is plain HIT', async () => {
  // messages has exactly suffix_turns=2 entries → slice(-2) returns all messages
  // sufBuf === normBuf → sk === nk === key → sufKey stays null → no suffix alias stored
  const body = {
    model: 'claude-haiku-test', max_tokens: 8,
    messages: [{ role: 'user', content: 'short-A' }, { role: 'assistant', content: 'ok' }],
  };
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
  await sleep(60);
  const r2 = await post(P.port, body);
  assert.equal(r2.xcache, 'HIT');        // plain HIT, not HIT-SUFFIX (sufKey null → no alias)
  assert.equal(P.state.count, 1);
});

test('suffix miss: unique suffix not in cache → reaches upstream', async () => {
  // last 2 messages have never been seen → all three tiers miss
  const body = {
    model: 'claude-haiku-test', max_tokens: 8,
    messages: [
      { role: 'user',      content: 'prefix-never' },
      { role: 'user',      content: 'unique-q-zz9' },
      { role: 'assistant', content: 'unique-a-zz9' },
    ],
  };
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
});

test('no messages field: normed.messages || [] fallback in suffix computation', async () => {
  // body without messages → (undefined || []).slice(-2) = [] → sufBuf has messages:[]
  // sufBuf ≠ body JSON → sufKey ≠ key → suffix alias IS written (empty messages suffix key)
  const body = { model: 'claude-haiku-test', max_tokens: 8, system: 'No-msgs body.' };
  const r = await post(P.port, body);
  assert.equal(r.xcache, 'MISS');
  assert.equal(P.state.count, 1);
});

test('suffix hit produces byte-identical replay', async () => {
  const shared = [
    { role: 'user',      content: 'What is osmium?' },
    { role: 'assistant', content: 'Osmium is element 76.' },
  ];
  const body1 = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'ctx-X' }, ...shared] };
  const body2 = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: 'ctx-Y' }, ...shared] };
  const a = await post(P.port, body1);
  assert.equal(a.xcache, 'MISS');
  await sleep(60);
  const b = await post(P.port, body2);
  assert.equal(b.xcache, 'HIT-SUFFIX');
  assert.ok(a.buf.equals(b.buf));
});
