#!/usr/bin/env node
// Fidelity + concurrency proof for the cache proxy. Zero deps.
// Drives REAL /v1/messages calls through the proxy (needs it running + a real key
// in .env) and asserts:
//   1. streaming SSE      — cold MISS then warm HIT, byte-identical replay
//   2. tool_use (JSON)    — cold MISS then warm HIT, byte-identical, tool_use block intact
//   3. streaming tool_use — the hard case: byte-identical SSE replay with tool_use events
//   4. coalescing         — a burst of N identical calls makes exactly ONE upstream call
//
// Run:  node test-fidelity.mjs              (uses cheap haiku; ~6 real calls)
//       node test-fidelity.mjs --model claude-sonnet-4-6
import http from 'node:http';

const PORT = +(process.env.CACHE_PORT || 4000);
const MODEL = (() => { const i = process.argv.indexOf('--model'); return i > -1 ? process.argv[i + 1] : 'claude-haiku-4-5-20251001'; })();
const NONCE = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;  // unique per run -> guarantees a cold first call
const TOOLS = [{ name: 'get_weather', description: 'Get the weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); };

function post(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-client', 'anthropic-version': '2023-06-01', 'content-length': data.length },
    }, (r) => { const parts = []; r.on('data', (c) => parts.push(c)); r.on('end', () => resolve({ status: r.statusCode, xcache: r.headers['x-cache'], buf: Buffer.concat(parts) })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function coldWarm(name, body, checks) {
  console.log(`\n# ${name}`);
  const a = await post(body);
  await sleep(150);                                 // let the cold call's disk write + inflight cleanup settle
  const b = await post(body);                       // identical -> must be served from cache, no upstream
  ok(a.status === 200, `cold status 200 (got ${a.status})`);
  ok(a.xcache === 'MISS', `cold is a MISS (got ${a.xcache})`);
  ok(b.xcache === 'HIT' || b.xcache === 'HIT-COALESCED', `warm served from cache, no upstream (got ${b.xcache})`);
  ok(a.buf.equals(b.buf), `replay is BYTE-IDENTICAL (${a.buf.length} vs ${b.buf.length} bytes)`);
  checks(a.buf.toString('utf8'));
}

async function main() {
  // 0. proxy reachable?
  await post({ model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'ping ' + NONCE }] })
    .catch((e) => { console.error('proxy not reachable on :' + PORT + ' — start it with ./cachectl-a.sh on'); throw e; });

  // 1. streaming text
  await coldWarm('1. streaming SSE', {
    model: MODEL, max_tokens: 64, stream: true,
    messages: [{ role: 'user', content: `Count from 1 to 5. nonce=${NONCE}` }],
  }, (t) => {
    ok(t.includes('event: message_start'), 'SSE has message_start');
    ok(t.includes('content_block_delta'), 'SSE has content_block_delta');
    ok(t.includes('message_stop'), 'SSE has message_stop (complete stream)');
  });

  // 2. tool_use (non-streaming JSON)
  await coldWarm('2. tool_use (JSON)', {
    model: MODEL, max_tokens: 256, tools: TOOLS, tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: `What is the weather in Paris? nonce=${NONCE}` }],
  }, (t) => {
    let j = {}; try { j = JSON.parse(t); } catch {}
    ok(j.stop_reason === 'tool_use', `stop_reason is tool_use (got ${j.stop_reason})`);
    ok(Array.isArray(j.content) && j.content.some((b) => b.type === 'tool_use'), 'response has a tool_use content block');
  });

  // 3. streaming + tool_use (the hard case)
  await coldWarm('3. streaming + tool_use', {
    model: MODEL, max_tokens: 256, stream: true, tools: TOOLS, tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: `Weather in Tokyo? nonce=${NONCE}` }],
  }, (t) => {
    ok(t.includes('"type":"tool_use"'), 'SSE contains a tool_use content block');
    ok(t.includes('input_json_delta'), 'SSE streams tool input via input_json_delta');
    ok(t.includes('message_stop'), 'SSE has message_stop (complete stream)');
  });

  // 4. coalescing: a burst of identical calls -> exactly ONE upstream MISS
  console.log('\n# 4. coalescing under a burst (6 identical, parallel)');
  const burstBody = { model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: `Say hi. burst=${NONCE}` }] };
  const N = 6;
  const results = await Promise.all(Array.from({ length: N }, () => post(burstBody)));
  const misses = results.filter((r) => r.xcache === 'MISS').length;
  const served = results.filter((r) => r.xcache === 'HIT' || r.xcache === 'HIT-COALESCED').length;
  ok(misses === 1, `exactly 1 upstream call for ${N} identical concurrent requests (got ${misses} MISS)`);
  ok(served === N - 1, `${N - 1} requests coalesced/served from cache (got ${served})`);
  ok(results.every((r) => r.buf.equals(results[0].buf)), 'all burst responses byte-identical');

  console.log(`\n==== ${fail === 0 ? 'ALL PASS' : 'FAILURES'} : ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
