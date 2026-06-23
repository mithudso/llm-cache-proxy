// debug verbosity + disabled file sink (CACHE_LOG_FILE=none).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, post, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot({ env: { CACHE_LOG_LEVEL: 'debug', CACHE_LOG_FILE: 'none' }, quiet: false }); });
after(() => P.close());

test('debug level emits DEBUG lines; CACHE_LOG_FILE=none writes no file', async () => {
  await post(P.port, uniq());        // emits a DEBUG line + a MISS line to stdout only
  await sleep(40);
  assert.equal(fs.existsSync(path.join(P.dir, 'proxy.log')), false);   // file sink disabled
});
