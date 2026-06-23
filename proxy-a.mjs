#!/usr/bin/env node
// Option A — zero-dependency byte-exact Anthropic caching proxy.
// Exact-match full-call cache: identical /v1/messages body -> replay stored bytes,
// no upstream call (100% token save). Streaming SSE + tool_use preserved verbatim.
//
// Concurrency: async I/O off the event loop, in-flight request coalescing (one
// upstream call per identical key under a burst), client-abort guard (a disconnect
// tears down the upstream and never crashes the process), throttled prune.
//
// Logging & monitoring: structured per-request logs, running tokens/dollars-saved
// counters seeded from metrics.jsonl on boot, GET /stats (JSON) + GET /metrics
// (Prometheus), per-model pricing (override via ~/.llm-cache-a/prices.json).
// Start: ANTHROPIC_API_KEY_REAL=... node proxy-a.mjs   (see cachectl-a.sh)
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const PORT = +(process.env.CACHE_PORT || 4000);
const UPSTREAM = 'api.anthropic.com';
const REAL_KEY = process.env.ANTHROPIC_API_KEY_REAL;
const CACHE_OFF = process.env.CACHE_OFF === '1';
const QUIET = process.env.CACHE_QUIET === '1';
const TTL_MS = +(process.env.CACHE_TTL_SEC || 604800) * 1000;
const MAX_ENTRIES = +(process.env.CACHE_MAX_ENTRIES || 5000);
const DIR = path.join(os.homedir(), '.llm-cache-a');
const ENTRIES = path.join(DIR, 'entries');
const METRICS = path.join(DIR, 'metrics.jsonl');
fs.mkdirSync(ENTRIES, { recursive: true });

if (!REAL_KEY) { console.error('FATAL: ANTHROPIC_API_KEY_REAL not set'); process.exit(1); }

// ---- pricing: $ per token [input, output]; matched by substring on the model id ----
let PRICES = { haiku: [0.8e-6, 4e-6], sonnet: [3e-6, 15e-6], opus: [15e-6, 75e-6] };
const DEFAULT_PRICE = [15e-6, 75e-6];
try { Object.assign(PRICES, JSON.parse(fs.readFileSync(path.join(DIR, 'prices.json'), 'utf8'))); } catch {}
const priceFor = (m) => { m = (m || '').toLowerCase(); for (const k in PRICES) if (m.includes(k)) return PRICES[k]; return DEFAULT_PRICE; };
const usd = (m, i, o) => { const [pi, po] = priceFor(m); return i * pi + o * po; };

// ---- counters (seeded from the metrics log so /stats survives restarts) ----
const c = {
  startedAt: Date.now(), calls: 0, hits: 0, coalesced: 0, misses: 0, errors: 0,
  savedIn: 0, savedOut: 0, savedUsd: 0, spentIn: 0, spentOut: 0, spentUsd: 0,
};
const applyHit = (m, i, o) => { c.calls++; c.hits++; c.savedIn += i; c.savedOut += o; c.savedUsd += usd(m, i, o); };
const applyMiss = (m, i, o) => { c.calls++; c.misses++; c.spentIn += i; c.spentOut += o; c.spentUsd += usd(m, i, o); };
function seed() {
  try {
    for (const line of fs.readFileSync(METRICS, 'utf8').split('\n')) {
      if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.event === 'hit') applyHit(r.model, r.in || 0, r.out || 0);
      else if (r.event === 'miss') applyMiss(r.model, r.in || 0, r.out || 0);
      else if (r.event === 'error') { c.calls++; c.errors++; }
    }
  } catch {}
}

const metric = (o) => { fsp.appendFile(METRICS, JSON.stringify({ t: Date.now(), ...o }) + '\n').catch(() => {}); };
const log = (s) => { if (!QUIET) process.stdout.write(s + '\n'); };
const hitRate = () => c.calls ? (100 * c.hits / c.calls) : 0;

// write to a possibly-disconnected client without throwing
const safe = (res, fn) => { try { if (!res.writableEnded && !res.destroyed) fn(); } catch {} };

function usageFrom(text) {
  let i = 0, o = 0;
  const im = text.match(/"input_tokens":(\d+)/); if (im) i = +im[1];
  const om = [...text.matchAll(/"output_tokens":(\d+)/g)]; if (om.length) o = +om[om.length - 1][1];
  return { input_tokens: i, output_tokens: o };
}

// ---- throttled, async LRU prune (entry count tracked in memory) ----
let entryCount = null, pruning = false;
async function maybePrune() {
  try {
    if (entryCount === null) entryCount = (await fsp.readdir(ENTRIES)).filter(f => f.endsWith('.bin')).length;
    if (entryCount <= MAX_ENTRIES || pruning) return;
    pruning = true;
    const files = (await fsp.readdir(ENTRIES)).filter(f => f.endsWith('.bin'));
    const ranked = [];
    for (const f of files) { try { ranked.push({ f, t: (await fsp.stat(path.join(ENTRIES, f))).mtimeMs }); } catch {} }
    ranked.sort((a, b) => a.t - b.t);
    for (const { f } of ranked.slice(0, files.length - MAX_ENTRIES)) {
      await fsp.rm(path.join(ENTRIES, f), { force: true }).catch(() => {});
      await fsp.rm(path.join(ENTRIES, f.replace(/\.bin$/, '.json')), { force: true }).catch(() => {});
    }
    entryCount = MAX_ENTRIES;
  } catch {} finally { pruning = false; }
}

async function readHit(file, meta) {
  const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
  if (Date.now() - m.ts >= TTL_MS) return null;             // expired
  const buf = await fsp.readFile(file);
  fsp.utimes(file, new Date(), new Date()).catch(() => {});  // LRU touch (fire-and-forget)
  return { m, buf };
}

function serveHit(res, m, buf, label) {
  safe(res, () => { res.writeHead(200, { 'content-type': m.contentType || 'application/json', 'x-cache': label }); res.end(buf); });
  const inT = m.usage?.input_tokens || 0, outT = m.usage?.output_tokens || 0;
  const d = usd(m.model, inT, outT);
  applyHit(m.model, inT, outT);
  if (label === 'HIT-COALESCED') c.coalesced++;
  metric({ event: 'hit', model: m.model, bytes: buf.length, in: inT, out: outT, usd: d, coalesced: label === 'HIT-COALESCED' });
  log(`${label.padEnd(13)} ${m.model || '?'}  +${inT + outT}tok $${d.toFixed(5)}  | saved $${c.savedUsd.toFixed(4)} / ${c.savedIn + c.savedOut}tok  hit-rate ${hitRate().toFixed(1)}%`);
}

const inflight = new Map();   // key -> Promise<{status, contentType, buf, model, usage}>

async function handle(req, res, body) {
  let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
  const model = parsed.model || '';
  const wantsStream = parsed.stream === true;
  const key = crypto.createHash('sha256').update(model + '\n').update(body).digest('hex');
  const file = path.join(ENTRIES, key + '.bin');
  const meta = path.join(ENTRIES, key + '.json');
  const bypass = CACHE_OFF || req.headers['x-cache-bypass'] === '1';

  // 1) disk cache hit
  if (!bypass) {
    try { const h = await readHit(file, meta); if (h) { serveHit(res, h.m, h.buf, 'HIT'); return; } } catch {}
  }

  // 2) coalesce onto an in-flight identical fetch (no second upstream call)
  if (!bypass && inflight.has(key)) {
    try {
      const r = await inflight.get(key);
      if (r && r.status === 200) { serveHit(res, { contentType: r.contentType, model: r.model, usage: r.usage }, r.buf, 'HIT-COALESCED'); return; }
      // first fetch was non-200/errored: replay its status+body so the waiter sees the same result
      if (r) { safe(res, () => { res.writeHead(r.status, { 'content-type': r.contentType, 'x-cache': 'MISS-COALESCED' }); res.end(r.buf); }); return; }
    } catch {}
    // fall through to own fetch if the shared one rejected
  }

  // 3) MISS — fetch upstream, stream live to THIS client, share the result via inflight
  const p = fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass);
  if (!bypass) { inflight.set(key, p); p.finally(() => { if (inflight.get(key) === p) inflight.delete(key); }); }
  await p.catch(() => {});
}

function fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    headers.host = UPSTREAM;
    headers['x-api-key'] = REAL_KEY;
    delete headers['authorization'];
    delete headers['accept-encoding'];
    headers['content-length'] = Buffer.byteLength(body);

    const t0 = Date.now();
    let settled = false;
    const up = https.request({ host: UPSTREAM, port: 443, path: req.url, method: 'POST', headers }, (ur) => {
      safe(res, () => res.writeHead(ur.statusCode, { ...ur.headers, 'x-cache': 'MISS' }));
      const parts = [];
      ur.on('data', (ch) => { parts.push(ch); safe(res, () => res.write(ch)); });
      ur.on('end', async () => {
        safe(res, () => res.end());
        const buf = Buffer.concat(parts);
        const text = buf.toString('utf8');
        const u = usageFrom(text);
        const contentType = ur.headers['content-type'] || 'application/json';
        const complete = ur.statusCode === 200 && (!wantsStream || text.includes('message_stop'));
        if (complete && !bypass) {
          try {
            await fsp.writeFile(file, buf);
            await fsp.writeFile(meta, JSON.stringify({ ts: Date.now(), model, contentType, usage: u }));
            if (entryCount !== null) entryCount++;
            maybePrune();
          } catch {}
        }
        applyMiss(model, u.input_tokens, u.output_tokens);
        const d = usd(model, u.input_tokens, u.output_tokens);
        metric({ event: 'miss', model, status: ur.statusCode, bytes: buf.length, in: u.input_tokens, out: u.output_tokens, usd: d, cached: complete });
        log(`MISS          ${model || '?'}  ${ur.statusCode}  ${u.input_tokens + u.output_tokens}tok $${d.toFixed(5)}  ${Date.now() - t0}ms${complete ? ' [cached]' : ''}  | spend $${c.spentUsd.toFixed(4)}`);
        settled = true;
        resolve({ status: ur.statusCode, contentType, buf, model, usage: u });
      });
    });
    up.on('error', (e) => {
      safe(res, () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-cache': 'ERROR' }); res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(e) } })); });
      c.calls++; c.errors++;
      metric({ event: 'error', model, err: String(e) });
      log(`ERR           ${model || '?'}  ${String(e)}`);
      settled = true;
      resolve(null);
    });
    // client abort: stop wasting the upstream call, never crash
    const onAbort = () => { if (!settled) up.destroy(new Error('client aborted')); };
    res.on('close', onAbort);
    res.on('error', () => {});
    req.on('error', () => {});
    up.write(body); up.end();
  });
}

// ---- monitoring views ----
function statsObj() {
  return {
    uptime_s: Math.round((Date.now() - c.startedAt) / 1000), cache: CACHE_OFF ? 'off' : 'on',
    calls: c.calls, hits: c.hits, coalesced: c.coalesced, misses: c.misses, errors: c.errors,
    hit_rate_pct: +hitRate().toFixed(2),
    tokens_saved: c.savedIn + c.savedOut, tokens_saved_in: c.savedIn, tokens_saved_out: c.savedOut,
    usd_saved: +c.savedUsd.toFixed(4), tokens_spent: c.spentIn + c.spentOut, usd_spent: +c.spentUsd.toFixed(4),
    savings_pct: (c.savedUsd + c.spentUsd) ? +(100 * c.savedUsd / (c.savedUsd + c.spentUsd)).toFixed(2) : 0,
  };
}
function prometheus() {
  const s = statsObj();
  return [
    '# TYPE llm_cache_calls_total counter', `llm_cache_calls_total ${s.calls}`,
    '# TYPE llm_cache_hits_total counter', `llm_cache_hits_total ${s.hits}`,
    '# TYPE llm_cache_coalesced_total counter', `llm_cache_coalesced_total ${s.coalesced}`,
    '# TYPE llm_cache_misses_total counter', `llm_cache_misses_total ${s.misses}`,
    '# TYPE llm_cache_errors_total counter', `llm_cache_errors_total ${s.errors}`,
    '# TYPE llm_cache_hit_ratio gauge', `llm_cache_hit_ratio ${(s.hit_rate_pct / 100).toFixed(4)}`,
    '# TYPE llm_cache_tokens_saved_total counter', `llm_cache_tokens_saved_total ${s.tokens_saved}`,
    '# TYPE llm_cache_usd_saved_total counter', `llm_cache_usd_saved_total ${s.usd_saved}`,
    `llm_cache_usd_spent_total ${s.usd_spent}`, '',
  ].join('\n');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  if (req.method === 'GET' && req.url.startsWith('/stats')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(statsObj(), null, 2)); return; }
  if (req.method === 'GET' && req.url.startsWith('/metrics')) { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(prometheus()); return; }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('error', () => {});
  req.on('data', (ch) => chunks.push(ch));
  req.on('end', () => { handle(req, res, Buffer.concat(chunks)).catch((e) => safe(res, () => { res.writeHead(500); res.end(String(e)); })); });
});

seed();
server.listen(PORT, () =>
  log(`option-a cache proxy: http://localhost:${PORT}  (cache ${CACHE_OFF ? 'OFF' : 'ON'}, ttl ${TTL_MS / 1000}s, max ${MAX_ENTRIES})\n` +
      `  monitor: GET /stats · GET /metrics · seeded ${c.calls} prior calls, $${c.savedUsd.toFixed(4)} saved · coalescing+async-io on`));
