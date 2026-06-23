#!/usr/bin/env node
// Option A — zero-dependency byte-exact Anthropic caching proxy.
// Exact-match full-call cache: identical /v1/messages body -> replay stored bytes,
// no upstream call (100% token save). Streaming SSE + tool_use preserved verbatim.
//
// Logging & monitoring:
//   - one structured log line per request (HIT/MISS/ERROR) on stdout (-> proxy.log)
//   - running counters: tokens saved, dollars saved, hit rate, upstream spend
//   - GET /stats   -> JSON counters     GET /metrics -> Prometheus text
//   - per-model pricing (haiku/sonnet/opus + override via ~/.llm-cache-a/prices.json)
// Start: ANTHROPIC_API_KEY_REAL=... node proxy-a.mjs   (see cachectl-a.sh)
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = +(process.env.CACHE_PORT || 4000);
const UPSTREAM = 'api.anthropic.com';
const REAL_KEY = process.env.ANTHROPIC_API_KEY_REAL;
const CACHE_OFF = process.env.CACHE_OFF === '1';
const QUIET = process.env.CACHE_QUIET === '1';                 // silence per-request logs
const TTL_MS = +(process.env.CACHE_TTL_SEC || 604800) * 1000;  // 7d
const MAX_ENTRIES = +(process.env.CACHE_MAX_ENTRIES || 5000);
const DIR = path.join(os.homedir(), '.llm-cache-a');
const ENTRIES = path.join(DIR, 'entries');
const METRICS = path.join(DIR, 'metrics.jsonl');
fs.mkdirSync(ENTRIES, { recursive: true });

if (!REAL_KEY) { console.error('FATAL: ANTHROPIC_API_KEY_REAL not set'); process.exit(1); }

// ---- pricing: $ per token [input, output]; matched by substring on the model id ----
let PRICES = {
  haiku: [0.8e-6, 4e-6],
  sonnet: [3e-6, 15e-6],
  opus: [15e-6, 75e-6],
};
const DEFAULT_PRICE = [15e-6, 75e-6];                          // unknown model -> assume opus (conservative)
try { Object.assign(PRICES, JSON.parse(fs.readFileSync(path.join(DIR, 'prices.json'), 'utf8'))); } catch {}
function priceFor(model) {
  const m = (model || '').toLowerCase();
  for (const k in PRICES) if (m.includes(k)) return PRICES[k];
  return DEFAULT_PRICE;
}
function usd(model, inTok, outTok) {
  const [pi, po] = priceFor(model);
  return inTok * pi + outTok * po;
}

// ---- running counters (seeded from the metrics log so /stats survives restarts) ----
const c = {
  startedAt: Date.now(), calls: 0, hits: 0, misses: 0, errors: 0,
  savedIn: 0, savedOut: 0, savedUsd: 0,                        // from cache hits (avoided spend)
  spentIn: 0, spentOut: 0, spentUsd: 0,                        // from misses (real upstream spend)
};
function applyHit(model, inTok, outTok) {
  c.calls++; c.hits++; c.savedIn += inTok; c.savedOut += outTok; c.savedUsd += usd(model, inTok, outTok);
}
function applyMiss(model, inTok, outTok) {
  c.calls++; c.misses++; c.spentIn += inTok; c.spentOut += outTok; c.spentUsd += usd(model, inTok, outTok);
}
function seed() {
  try {
    for (const line of fs.readFileSync(METRICS, 'utf8').split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.event === 'hit') applyHit(r.model, r.in || 0, r.out || 0);
      else if (r.event === 'miss') applyMiss(r.model, r.in || 0, r.out || 0);
      else if (r.event === 'error') { c.calls++; c.errors++; }
    }
  } catch {}
}

const metric = (o) => { try { fs.appendFileSync(METRICS, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };
const log = (s) => { if (!QUIET) process.stdout.write(s + '\n'); };
const hitRate = () => c.calls ? (100 * c.hits / c.calls) : 0;

function usageFrom(text) {
  let i = 0, o = 0;
  const im = text.match(/"input_tokens":(\d+)/); if (im) i = +im[1];
  const om = [...text.matchAll(/"output_tokens":(\d+)/g)]; if (om.length) o = +om[om.length - 1][1];
  return { input_tokens: i, output_tokens: o };
}

function prune() {
  try {
    const files = fs.readdirSync(ENTRIES).filter(f => f.endsWith('.bin'));
    if (files.length <= MAX_ENTRIES) return;
    const ranked = files.map(f => ({ f, t: fs.statSync(path.join(ENTRIES, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const { f } of ranked.slice(0, files.length - MAX_ENTRIES)) {
      fs.rmSync(path.join(ENTRIES, f), { force: true });
      fs.rmSync(path.join(ENTRIES, f.replace(/\.bin$/, '.json')), { force: true });
    }
  } catch {}
}

function serveHit(res, file, meta) {
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  if (Date.now() - m.ts >= TTL_MS) return false;              // expired
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': m.contentType || 'application/json', 'x-cache': 'HIT' });
  res.end(buf);
  fs.utimesSync(file, new Date(), new Date());                // LRU touch
  const inT = m.usage?.input_tokens || 0, outT = m.usage?.output_tokens || 0;
  const d = usd(m.model, inT, outT);
  applyHit(m.model, inT, outT);
  metric({ event: 'hit', model: m.model, bytes: buf.length, in: inT, out: outT, usd: d });
  log(`HIT  ${m.model || '?'}  +${inT + outT}tok $${d.toFixed(5)}  | saved $${c.savedUsd.toFixed(4)} / ${(c.savedIn + c.savedOut)}tok  hit-rate ${hitRate().toFixed(1)}%`);
  return true;
}

function handle(req, res, body) {
  let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
  const model = parsed.model || '';
  const wantsStream = parsed.stream === true;
  const k = crypto.createHash('sha256').update(model + '\n').update(body).digest('hex');
  const file = path.join(ENTRIES, k + '.bin');
  const meta = path.join(ENTRIES, k + '.json');
  const bypass = CACHE_OFF || req.headers['x-cache-bypass'] === '1';

  if (!bypass && fs.existsSync(file) && fs.existsSync(meta)) {
    try { if (serveHit(res, file, meta)) return; } catch {}   // fall through to miss on any read error
  }

  // MISS -> forward upstream with the REAL key, plaintext (no gzip) for clean replay
  const headers = { ...req.headers };
  headers.host = UPSTREAM;
  headers['x-api-key'] = REAL_KEY;
  delete headers['authorization'];
  delete headers['accept-encoding'];
  headers['content-length'] = Buffer.byteLength(body);

  const t0 = Date.now();
  const up = https.request({ host: UPSTREAM, port: 443, path: req.url, method: 'POST', headers }, (ur) => {
    res.writeHead(ur.statusCode, { ...ur.headers, 'x-cache': 'MISS' });
    const parts = [];
    ur.on('data', ch => { parts.push(ch); res.write(ch); });
    ur.on('end', () => {
      res.end();
      const buf = Buffer.concat(parts);
      const text = buf.toString('utf8');
      const u = usageFrom(text);
      const complete = ur.statusCode === 200 && (!wantsStream || text.includes('message_stop'));
      if (complete && !bypass) {
        try {
          fs.writeFileSync(file, buf);
          fs.writeFileSync(meta, JSON.stringify({ ts: Date.now(), model, contentType: ur.headers['content-type'] || 'application/json', usage: u }));
          prune();
        } catch {}
      }
      applyMiss(model, u.input_tokens, u.output_tokens);
      const d = usd(model, u.input_tokens, u.output_tokens);
      metric({ event: 'miss', model, status: ur.statusCode, bytes: buf.length, in: u.input_tokens, out: u.output_tokens, usd: d, cached: complete });
      log(`MISS ${model || '?'}  ${ur.statusCode}  ${u.input_tokens + u.output_tokens}tok $${d.toFixed(5)}  ${Date.now() - t0}ms${complete ? ' [cached]' : ''}  | spend $${c.spentUsd.toFixed(4)}`);
    });
  });
  up.on('error', (e) => {                                     // fail-open: never break the client
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-cache': 'ERROR' });
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(e) } }));
    c.calls++; c.errors++;
    metric({ event: 'error', model, err: String(e) });
    log(`ERR  ${model || '?'}  ${String(e)}`);
  });
  up.write(body); up.end();
}

// ---- monitoring views ----
function statsObj() {
  return {
    uptime_s: Math.round((Date.now() - c.startedAt) / 1000),
    cache: CACHE_OFF ? 'off' : 'on',
    calls: c.calls, hits: c.hits, misses: c.misses, errors: c.errors,
    hit_rate_pct: +hitRate().toFixed(2),
    tokens_saved: c.savedIn + c.savedOut, tokens_saved_in: c.savedIn, tokens_saved_out: c.savedOut,
    usd_saved: +c.savedUsd.toFixed(4),
    tokens_spent: c.spentIn + c.spentOut, usd_spent: +c.spentUsd.toFixed(4),
    savings_pct: (c.savedUsd + c.spentUsd) ? +(100 * c.savedUsd / (c.savedUsd + c.spentUsd)).toFixed(2) : 0,
  };
}
function prometheus() {
  const s = statsObj();
  return [
    '# HELP llm_cache_calls_total Total requests handled', '# TYPE llm_cache_calls_total counter',
    `llm_cache_calls_total ${s.calls}`,
    '# TYPE llm_cache_hits_total counter', `llm_cache_hits_total ${s.hits}`,
    '# TYPE llm_cache_misses_total counter', `llm_cache_misses_total ${s.misses}`,
    '# TYPE llm_cache_errors_total counter', `llm_cache_errors_total ${s.errors}`,
    '# TYPE llm_cache_hit_ratio gauge', `llm_cache_hit_ratio ${(s.hit_rate_pct / 100).toFixed(4)}`,
    '# HELP llm_cache_tokens_saved_total Tokens avoided via cache hits', '# TYPE llm_cache_tokens_saved_total counter',
    `llm_cache_tokens_saved_total ${s.tokens_saved}`,
    '# HELP llm_cache_usd_saved_total Dollars avoided via cache hits', '# TYPE llm_cache_usd_saved_total counter',
    `llm_cache_usd_saved_total ${s.usd_saved}`,
    `llm_cache_usd_spent_total ${s.usd_spent}`,
    '',
  ].join('\n');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/stats')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(statsObj(), null, 2)); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/metrics')) {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(prometheus()); return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', ch => chunks.push(ch));
  req.on('end', () => handle(req, res, Buffer.concat(chunks)));
});

seed();
// Default dual-stack bind (::) accepts BOTH localhost(::1) and 127.0.0.1.
server.listen(PORT, () =>
  log(`option-a cache proxy: http://localhost:${PORT}  (cache ${CACHE_OFF ? 'OFF' : 'ON'}, ttl ${TTL_MS / 1000}s, max ${MAX_ENTRIES})\n` +
      `  monitor: GET /stats (json) · GET /metrics (prometheus) · seeded ${c.calls} prior calls, $${c.savedUsd.toFixed(4)} saved`));
