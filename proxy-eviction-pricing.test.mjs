import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boot, post, uniq, sleep } from './test-helpers.mjs';
let P;
before(async () => { P = await boot({ env: { CACHE_MAX_ENTRIES: 5 }, seedPrices: { 'claude-haiku-4-5-20251001': [0.001, 0.002] } }); });
after(() => P.close());
const keyOf = body => crypto.createHash('sha256').update(body.model + '\n').update(JSON.stringify(body)).digest('hex');

test('specific model pricing wins over a broader built-in family match', () => {
  assert.deepEqual(P.mod.priceFor('claude-haiku-4-5-20251001'), [0.001, 0.002]);
  assert.equal(P.mod.usd('claude-haiku-4-5-20251001', 10, 5), 0.02);
  assert.deepEqual(P.mod.priceFor('claude-haiku-other'), [0.8e-6, 4e-6]);
});

test('invalidation followed by an overwrite never prunes entries below capacity', async () => {
  const bodies = Array.from({ length: 5 }, () => uniq());
  for (const body of bodies) { await post(P.port, body); await P.waitForEntry(body); }
  await sleep(30); // observe the asynchronously scheduled initial count scan
  assert.equal(P.entries().filter(file => file.endsWith('.bin')).length, 5);
  for (const ext of ['.bin', '.json']) fs.unlinkSync(path.join(P.dir, 'entries', keyOf(bodies[0]) + ext));
  const metadata = path.join(P.dir, 'entries', keyOf(bodies[1]) + '.json');
  const meta = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  fs.writeFileSync(metadata, JSON.stringify({ ...meta, ts: 0 }));
  assert.equal((await post(P.port, bodies[1])).xcache, 'MISS');
  await P.waitForEntry(bodies[1]);
  await sleep(80); // negative assertion: allow an erroneous async deletion to become observable
  const remaining = P.entries().filter(file => file.endsWith('.bin'));
  assert.equal(remaining.length, 4);
  for (const body of bodies.slice(1)) assert.ok(remaining.includes(keyOf(body) + '.bin'));
});
