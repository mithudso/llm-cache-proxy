// Not-quiet boot exercises the log() write path, the start() banner, and the default log file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, post, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ quiet: false }); });   // default CACHE_LOG_FILE = <home>/.llm-cache-a/proxy.log
after(() => P.close());

test('logging runs when not quiet, and tees to the default log file', async () => {
  const body = uniq();
  assert.equal((await post(P.port, body)).xcache, 'MISS');   // MISS log line
  await sleep(60);
  assert.equal((await post(P.port, body)).xcache, 'HIT');    // HIT log line
  await sleep(40);                                           // let the async file append flush
  const logged = fs.readFileSync(path.join(P.dir, 'proxy.log'), 'utf8');
  assert.match(logged, /MISS/);
  assert.match(logged, /HIT/);
});
