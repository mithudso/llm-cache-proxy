// GET /monitor holds an SSE stream and receives a live event per served call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, post, uniq, sleep } from './test-helpers.mjs';

let P;
before(async () => { P = await boot(); });
after(() => P.close());

function openMonitor(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/monitor' }, (res) => {
      const events = [];
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = frame.match(/^data: (.*)$/m);
          if (m) { try { events.push(JSON.parse(m[1])); } catch { /* ignore */ } }
        }
      });
      resolve({ req, res, events });
    });
    req.on('error', () => {});
  });
}

test('/monitor streams a connected frame then a live MISS event', async () => {
  const mon = await openMonitor(P.port);
  await sleep(30);
  assert.equal(mon.events[0]?.type, 'connected');

  await post(P.port, uniq());            // one live MISS
  await sleep(80);                        // let the broadcast arrive
  const miss = mon.events.find((e) => e.type === 'MISS');
  assert.ok(miss, 'monitor received a MISS event');
  assert.equal(miss.from_cache, false);
  assert.equal(miss.stored, true);       // a cacheable 200 MISS is persisted
  assert.equal(P.state.count, 1);

  mon.req.destroy();                      // disconnect -> server drops it from the monitor set
  await sleep(40);
});
