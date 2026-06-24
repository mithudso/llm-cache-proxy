#!/usr/bin/env node
// test-normalize-example.mjs — verifies normalize.json.example patterns against a mock upstream.
// No real Anthropic key or network access needed; uses CACHE_UPSTREAM_* test hooks.
// Run:  node test-normalize-example.mjs
// Env:  (none required)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, post, sleep, jsonResponder } from './test-helpers.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(DIR, 'normalize.json.example'), 'utf8'));

let passed = 0, failed = 0, n = 0;
const ok  = (name) => { passed++; process.stdout.write(`  ✓ ${name}\n`); };
const err = (name, got) => { failed++; process.stdout.write(`  ✗ ${name} — got ${JSON.stringify(got)}\n`); };
const uniq = (suffix) => `[t${++n}] ${suffix}`;  // unique suffix prevents cross-test cache collision

process.stdout.write('Testing normalize.json.example patterns against mock upstream...\n\n');

const P = await boot({ seedNormalize: EXAMPLE });

// Helpers shared across cases
const mkBody = (system, msgContent) => ({
  model: 'claude-haiku-test',
  max_tokens: 8,
  system,
  messages: [{ role: 'user', content: msgContent }],
});
const miss_then_norm = async (name, body1, body2) => {
  P.resetCount();
  const r1 = await post(P.port, body1);
  await sleep(80);
  const r2 = await post(P.port, body2);
  if (r1.xcache === 'MISS' && r2.xcache === 'HIT-NORM' && P.state.count === 1)
    ok(name);
  else
    err(name, { r1: r1.xcache, r2: r2.xcache, upstream: P.state.count });
};

// ── 1. Current date line ──────────────────────────────────────────────────────
const q1 = uniq('what is osmium?');
await miss_then_norm(
  'system_strip "Current date..." — HIT-NORM when only date differs',
  mkBody(`Current date: 2026-01-01\nYou are a helpful assistant.`, q1),
  mkBody(`Current date: 2026-06-24\nYou are a helpful assistant.`, q1),
);

// ── 2. "Today's date" / "Today is" phrase ────────────────────────────────────
const q2 = uniq('what is titanium?');
await miss_then_norm(
  'system_strip "Today\'s date..." — HIT-NORM when date phrase differs',
  mkBody(`Today's date: January 1, 2026\nAssist the user.`, q2),
  mkBody(`Today's date: June 24, 2026\nAssist the user.`, q2),
);

const q3 = uniq('what is vanadium?');
await miss_then_norm(
  'system_strip "Today is..." — HIT-NORM when date phrase differs',
  mkBody(`Today is Monday, Jan 1 2026\nAnswer concisely.`, q3),
  mkBody(`Today is Tuesday, Jun 24 2026\nAnswer concisely.`, q3),
);

// ── 3. UUID in system prompt ──────────────────────────────────────────────────
const q4 = uniq('what is chromium?');
await miss_then_norm(
  'system_strip UUID pattern — HIT-NORM when UUID changes',
  mkBody(`Context: a1b2c3d4-e5f6-7890-abcd-ef1234567890\nExplain briefly.`, q4),
  mkBody(`Context: 9f8e7d6c-5b4a-3210-fedc-ba9876543210\nExplain briefly.`, q4),
);

// ── 4. Session-ID line ────────────────────────────────────────────────────────
const q5 = uniq('what is manganese?');
await miss_then_norm(
  'system_strip "Session ID: ..." — HIT-NORM when session ID changes',
  mkBody(`Session ID: abc123xyz\nYou are in a coding session.`, q5),
  mkBody(`Session ID: xyz789pqr\nYou are in a coding session.`, q5),
);

const q6 = uniq('what is nickel?');
await miss_then_norm(
  'system_strip "Session-ID: ..." (hyphenated) — HIT-NORM when session ID changes',
  mkBody(`Session-ID: sess_aaaBBBccc\nContext follows.`, q6),
  mkBody(`Session-ID: sess_xxxYYYzzz\nContext follows.`, q6),
);

// ── 5. message_strip: tool_result in string message content ──────────────────
{
  P.resetCount();
  const q = uniq('describe this file');
  const body1 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: 'You are helpful.',
    messages: [{ role: 'user', content: `Context: <tool_result>{"mtime":"2026-01-01","size":100}</tool_result>\n${q}` }],
  };
  const body2 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: 'You are helpful.',
    messages: [{ role: 'user', content: `Context: <tool_result>{"mtime":"2026-06-24","size":200}</tool_result>\n${q}` }],
  };
  const r1 = await post(P.port, body1);
  await sleep(80);
  const r2 = await post(P.port, body2);
  if (r1.xcache === 'MISS' && r2.xcache === 'HIT-NORM' && P.state.count === 1)
    ok('message_strip <tool_result> — HIT-NORM when tool result content differs');
  else
    err('message_strip <tool_result>', { r1: r1.xcache, r2: r2.xcache, upstream: P.state.count });
}

// ── 6. No-pattern body → exact MISS/HIT preserved (no interference) ──────────
{
  P.resetCount();
  const body = { model: 'claude-haiku-test', max_tokens: 8, messages: [{ role: 'user', content: uniq('no patterns here') }] };
  const r1 = await post(P.port, body);
  await sleep(80);
  const r2 = await post(P.port, body);
  if (r1.xcache === 'MISS' && r2.xcache === 'HIT' && P.state.count === 1)
    ok('no matching patterns — exact MISS+HIT preserved (normalization is a no-op)');
  else
    err('no pattern match', { r1: r1.xcache, r2: r2.xcache, upstream: P.state.count });
}

// ── 7. Different content → MISS (not confused with another entry) ─────────────
{
  P.resetCount();
  const body1 = { model: 'claude-haiku-test', max_tokens: 8, system: 'Static system A.', messages: [{ role: 'user', content: uniq('question A') }] };
  const body2 = { model: 'claude-haiku-test', max_tokens: 8, system: 'Static system B.', messages: [{ role: 'user', content: uniq('question B') }] };
  const r1 = await post(P.port, body1);
  await sleep(80);
  const r2 = await post(P.port, body2);
  if (r1.xcache === 'MISS' && r2.xcache === 'MISS' && P.state.count === 2)
    ok('different logical content → MISS (no false HIT-NORM)');
  else
    err('different content isolation', { r1: r1.xcache, r2: r2.xcache, upstream: P.state.count });
}

// ── 8. Combined Claude Code style: date + UUID together ───────────────────────
{
  const q = uniq('list project files');
  const mkCC = (date, uuid) =>
    `Current date: ${date}\nContext-ID: ${uuid}\nYou are Claude Code, an AI programming assistant.\nAnswer in plain text.`;
  await miss_then_norm(
    'Claude Code style prompt — HIT-NORM when date + UUID both change',
    mkBody(mkCC('2026-01-01', 'aaaaaaaa-0000-0000-0000-000000000001'), q),
    mkBody(mkCC('2026-06-24', 'bbbbbbbb-1111-1111-1111-111111111112'), q),
  );
}

// ── 9. Array block content (Claude API format) — system strip still applies ───
{
  P.resetCount();
  const q = uniq('block content test');
  const body1 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: `Current date: 2026-01-01\nAssist.`,
    messages: [{ role: 'user', content: [{ type: 'text', text: q }] }],
  };
  const body2 = {
    model: 'claude-haiku-test', max_tokens: 8,
    system: `Current date: 2026-06-24\nAssist.`,
    messages: [{ role: 'user', content: [{ type: 'text', text: q }] }],
  };
  const r1 = await post(P.port, body1);
  await sleep(80);
  const r2 = await post(P.port, body2);
  if (r1.xcache === 'MISS' && r2.xcache === 'HIT-NORM' && P.state.count === 1)
    ok('array block message content — system_strip still applies → HIT-NORM');
  else
    err('array block content', { r1: r1.xcache, r2: r2.xcache, upstream: P.state.count });
}

// ── 10. Byte-identical replay on HIT-NORM ─────────────────────────────────────
{
  P.resetCount();
  const q = uniq('replay fidelity');
  const body1 = mkBody(`Current date: 2026-01-01\nBe brief.`, q);
  const body2 = mkBody(`Current date: 2026-06-24\nBe brief.`, q);
  const r1 = await post(P.port, body1);
  await sleep(80);
  const r2 = await post(P.port, body2);
  if (r2.xcache === 'HIT-NORM' && r1.buf.equals(r2.buf))
    ok('HIT-NORM replay is byte-identical to original MISS response');
  else
    err('HIT-NORM byte fidelity', { xcache: r2.xcache, sameBytes: r1.buf.equals(r2.buf) });
}

await P.close();

process.stdout.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  process.stderr.write(`\n${failed} test(s) failed.\n`);
  process.exit(1);
}
