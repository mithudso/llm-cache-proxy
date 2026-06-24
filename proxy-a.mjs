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
import { fileURLToPath } from 'node:url';

const PORT = +(process.env.CACHE_PORT || 4000);
// Bind address. Loopback by default (the proxy spends the real key for ANY client,
// so it must not be reachable off-box unless you opt in). Set CACHE_HOST to a LAN
// address / 0.0.0.0 to expose it — which then REQUIRES CACHE_AUTH_TOKEN (see start()).
const HOST = process.env.CACHE_HOST || '127.0.0.1';
const AUTH = process.env.CACHE_AUTH_TOKEN || '';
const isLoopbackHost = (h) => ['127.0.0.1', '::1', 'localhost'].includes(h);
/* node:coverage disable */ /* production upstream defaults; tests always set CACHE_UPSTREAM_* */
const UPSTREAM = process.env.CACHE_UPSTREAM_HOST || 'api.anthropic.com';
const UPSTREAM_PORT = +(process.env.CACHE_UPSTREAM_PORT || 443);
// production talks HTTPS to Anthropic; tests point this at a local HTTP mock via CACHE_UPSTREAM_PROTO=http
const UPSTREAM_AGENT = process.env.CACHE_UPSTREAM_PROTO === 'http' ? http : https;
/* node:coverage enable */
const REAL_KEY = process.env.ANTHROPIC_API_KEY_REAL;
const CACHE_OFF = process.env.CACHE_OFF === '1';
const QUIET = process.env.CACHE_QUIET === '1';
const TTL_MS = +(process.env.CACHE_TTL_SEC || 604800) * 1000;
const MAX_ENTRIES = +(process.env.CACHE_MAX_ENTRIES || 5000);
const DIR = path.join(os.homedir(), '.llm-cache-a');
const ENTRIES = path.join(DIR, 'entries');
const METRICS = path.join(DIR, 'metrics.jsonl');
// Log verbosity: silent<error<info<debug. CACHE_QUIET=1 stays as an alias for silent.
const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.CACHE_LOG_LEVEL] ?? (QUIET ? 0 : 2);
// Default log file (in addition to stdout). Set CACHE_LOG_FILE=none to disable, or a path to override.
const LOG_FILE = process.env.CACHE_LOG_FILE === 'none' ? '' : (process.env.CACHE_LOG_FILE || path.join(DIR, 'proxy.log'));
fs.mkdirSync(ENTRIES, { recursive: true });

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
// snapshot of the live counters; sessionBase is re-captured in start() AFTER seed(),
// so "session" stats = activity since this process booted, "all-time" = seeded + session.
const snapshot = () => ({ calls: c.calls, hits: c.hits, coalesced: c.coalesced, misses: c.misses, errors: c.errors, savedIn: c.savedIn, savedOut: c.savedOut, savedUsd: c.savedUsd, spentIn: c.spentIn, spentOut: c.spentOut, spentUsd: c.spentUsd });
let sessionBase = snapshot();
// Replay the metrics ledger into the counters at boot so /stats survives restarts.
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

/* node:coverage disable */ /* swallows fire-and-forget I/O errors; only runs on rare disk/socket failure */
const noop = () => {};
/* node:coverage enable */
const metric = (o) => { fsp.appendFile(METRICS, JSON.stringify({ t: Date.now(), ...o }) + '\n').catch(noop); };
// Emit a log line at the given level (default info) to stdout + the log file, if verbosity allows.
const log = (s, level = LOG_LEVELS.info) => {
  if (level > LOG_LEVEL) return;
  process.stdout.write(s + '\n');
  if (LOG_FILE) fsp.appendFile(LOG_FILE, s + '\n').catch(noop);
};
const hitRate = () => c.calls ? (100 * c.hits / c.calls) : 0;

// write to a possibly-disconnected client without throwing
const safe = (res, fn) => {
  /* node:coverage disable */ /* guards a write to a client that has already disconnected */
  if (res.writableEnded || res.destroyed) return;
  /* node:coverage enable */
  try { fn(); }
  /* node:coverage disable */ /* client vanished mid-write */
  catch {}
  /* node:coverage enable */
};

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
    if (entryCount <= MAX_ENTRIES) return;
    /* node:coverage disable */ /* reentrancy guard: a prune is already in flight (timing-racy to hit) */
    if (pruning) return;
    /* node:coverage enable */
    pruning = true;
    const files = (await fsp.readdir(ENTRIES)).filter(f => f.endsWith('.bin'));
    const ranked = [];
    for (const f of files) {
      try { ranked.push({ f, t: (await fsp.stat(path.join(ENTRIES, f))).mtimeMs }); }
      /* node:coverage disable */
      catch { /* entry vanished mid-prune */ }
      /* node:coverage enable */
    }
    ranked.sort((a, b) => a.t - b.t);
    for (const { f } of ranked.slice(0, files.length - MAX_ENTRIES)) {
      await fsp.rm(path.join(ENTRIES, f), { force: true }).catch(noop);
      await fsp.rm(path.join(ENTRIES, f.replace(/\.bin$/, '.json')), { force: true }).catch(noop);
    }
    entryCount = MAX_ENTRIES;
  /* node:coverage disable */ /* defensive: prune failures must never throw */
  } catch {} /* node:coverage enable */ finally { pruning = false; }
}

// Load a cached entry if its meta exists and is within TTL; touch it for LRU. Null = miss/expired.
async function readHit(file, meta) {
  const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
  if (Date.now() - m.ts >= TTL_MS) return null;             // expired
  const buf = await fsp.readFile(file);
  fsp.utimes(file, new Date(), new Date()).catch(noop);  // LRU touch (fire-and-forget)
  return { m, buf };
}

// Replay a cached payload to the client byte-for-byte, update hit counters, log, and broadcast.
function serveHit(res, m, buf, label, seq) {
  safe(res, () => { res.writeHead(200, { 'content-type': m.contentType || 'application/json', 'x-cache': label }); res.end(buf); });
  const inT = m.usage?.input_tokens || 0, outT = m.usage?.output_tokens || 0;
  const d = usd(m.model, inT, outT);
  applyHit(m.model, inT, outT);
  if (label === 'HIT-COALESCED') c.coalesced++;
  metric({ event: 'hit', model: m.model, bytes: buf.length, in: inT, out: outT, usd: d, coalesced: label === 'HIT-COALESCED' });
  log(`${label.padEnd(13)} ${m.model || '?'}  +${inT + outT}tok $${d.toFixed(5)}  | saved $${c.savedUsd.toFixed(4)} / ${c.savedIn + c.savedOut}tok  hit-rate ${hitRate().toFixed(1)}%`);
  /* node:coverage disable */ /* best-effort snippet for monitor display; null-chain branches not worth testing */
  let monExtra = {};
  if ((m.contentType || '').includes('application/json')) {
    try { const snip = JSON.parse(buf.toString('utf8')).content?.[0]?.text?.slice(0, 80); if (snip != null) monExtra = { snippet: snip }; } catch {}
  }
  /* node:coverage enable */
  broadcast({ seq, type: label, from_cache: true, model: m.model, in: inT, out: outT, usd: d, ...monExtra });
}

const inflight = new Map();   // key -> Promise<{status, contentType, buf, model, usage}>

// ---- realtime monitor: GET /monitor holds an SSE stream; every served call is broadcast live ----
const monitors = new Set();   // open /monitor response objects
let callSeq = 0;              // monotonic per-process call counter, included in every broadcast event
const broadcast = (ev) => {
  if (!monitors.size) return;
  const line = `data: ${JSON.stringify({ t: Date.now(), ...ev })}\n\n`;
  for (const m of monitors) safe(m, () => m.write(line));
};

// Core request path: hash the body to a key, then try disk-cache → coalesce → upstream fetch.
async function handle(req, res, body) {
  const seq = ++callSeq;
  let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
  const model = parsed.model || '';
  const wantsStream = parsed.stream === true;
  const key = crypto.createHash('sha256').update(model + '\n').update(body).digest('hex');
  const file = path.join(ENTRIES, key + '.bin');
  const meta = path.join(ENTRIES, key + '.json');
  const bypass = CACHE_OFF || req.headers['x-cache-bypass'] === '1';
  log(`DEBUG ${model || '?'} key=${key.slice(0, 12)} stream=${wantsStream}${bypass ? ' bypass' : ''}`, LOG_LEVELS.debug);

  // 1) disk cache hit
  if (!bypass) {
    try { const h = await readHit(file, meta); if (h) { serveHit(res, h.m, h.buf, 'HIT', seq); return; } } catch {}
  }

  // 2) coalesce onto an in-flight identical fetch (no second upstream call)
  if (!bypass && inflight.has(key)) {
    try {
      const r = await inflight.get(key);
      if (r && r.status === 200) { serveHit(res, { contentType: r.contentType, model: r.model, usage: r.usage }, r.buf, 'HIT-COALESCED', seq); return; }
      // first fetch was non-200/errored: replay its status+body so the waiter sees the same result
      if (r) { safe(res, () => { res.writeHead(r.status, { 'content-type': r.contentType, 'x-cache': 'MISS-COALESCED' }); res.end(r.buf); }); broadcast({ seq, type: 'MISS-COALESCED', from_cache: false, model: r.model, status: r.status }); return; }
    } catch {}
    // fall through to own fetch if the shared one rejected
  }

  // 3) MISS — fetch upstream, stream live to THIS client, share the result via inflight
  const p = fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass, seq);
  if (!bypass) { inflight.set(key, p); p.finally(() => { if (inflight.get(key) === p) inflight.delete(key); }); }
  await p.catch(noop);
}

// Forward to the real API, stream the response live to the client, persist a complete 200, and
// resolve with the result so coalesced waiters can replay it. Never rejects (resolves null on error).
function fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass, seq) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    headers.host = UPSTREAM;
    headers['x-api-key'] = REAL_KEY;
    delete headers['authorization'];
    delete headers['accept-encoding'];
    headers['content-length'] = Buffer.byteLength(body);

    const t0 = Date.now();
    let settled = false;
    const up = UPSTREAM_AGENT.request({ host: UPSTREAM, port: UPSTREAM_PORT, path: req.url, method: 'POST', headers }, (ur) => {
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
          /* node:coverage disable */ /* a failed cache write must not break the live response */
          } catch {}
          /* node:coverage enable */
        }
        applyMiss(model, u.input_tokens, u.output_tokens);
        const d = usd(model, u.input_tokens, u.output_tokens);
        metric({ event: 'miss', model, status: ur.statusCode, bytes: buf.length, in: u.input_tokens, out: u.output_tokens, usd: d, cached: complete });
        log(`MISS          ${model || '?'}  ${ur.statusCode}  ${u.input_tokens + u.output_tokens}tok $${d.toFixed(5)}  ${Date.now() - t0}ms${complete ? ' [cached]' : ''}  | spend $${c.spentUsd.toFixed(4)}`);
        /* node:coverage disable */ /* best-effort snippet for monitor display; null-chain branches not worth testing */
        let monExtra = {};
        if (!wantsStream && ur.statusCode === 200) {
          try { const snip = JSON.parse(text).content?.[0]?.text?.slice(0, 80); if (snip != null) monExtra = { snippet: snip }; } catch {}
        }
        /* node:coverage enable */
        broadcast({ seq, type: 'MISS', from_cache: false, stored: complete, model, status: ur.statusCode, in: u.input_tokens, out: u.output_tokens, usd: d, ms: Date.now() - t0, ...monExtra });
        settled = true;
        resolve({ status: ur.statusCode, contentType, buf, model, usage: u });
      });
    });
    up.on('error', (e) => {
      safe(res, () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-cache': 'ERROR' }); res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(e) } })); });
      c.calls++; c.errors++;
      metric({ event: 'error', model, err: String(e) });
      log(`ERR           ${model || '?'}  ${String(e)}`, LOG_LEVELS.error);
      broadcast({ seq, type: 'ERROR', from_cache: false, model, err: String(e) });
      settled = true;
      resolve(null);
    });
    // client abort: stop wasting the upstream call, never crash
    const onAbort = () => { if (!settled) up.destroy(new Error('client aborted')); };
    res.on('close', onAbort);
    res.on('error', noop);
    req.on('error', noop);
    up.write(body); up.end();
  });
}

// ---- monitoring views ----
// shared shape for both the all-time and the this-session counter sets
const view = (calls, hits, coalesced, misses, errors, savedIn, savedOut, savedUsd, spentIn, spentOut, spentUsd) => ({
  calls, hits, coalesced, misses, errors,
  hit_rate_pct: +(calls ? 100 * hits / calls : 0).toFixed(2),
  tokens_saved: savedIn + savedOut, tokens_saved_in: savedIn, tokens_saved_out: savedOut,
  usd_saved: +savedUsd.toFixed(4), tokens_spent: spentIn + spentOut, usd_spent: +spentUsd.toFixed(4),
  savings_pct: (savedUsd + spentUsd) ? +(100 * savedUsd / (savedUsd + spentUsd)).toFixed(2) : 0,
});
function statsObj() {
  const b = sessionBase;
  // top-level fields = ALL-TIME (seeded + session; backward-compatible with /metrics & older readers)
  return {
    uptime_s: Math.round((Date.now() - c.startedAt) / 1000), cache: CACHE_OFF ? 'off' : 'on',
    ...view(c.calls, c.hits, c.coalesced, c.misses, c.errors, c.savedIn, c.savedOut, c.savedUsd, c.spentIn, c.spentOut, c.spentUsd),
    // this-session-only deltas since the process booted
    session: view(c.calls - b.calls, c.hits - b.hits, c.coalesced - b.coalesced, c.misses - b.misses, c.errors - b.errors,
      c.savedIn - b.savedIn, c.savedOut - b.savedOut, c.savedUsd - b.savedUsd, c.spentIn - b.spentIn, c.spentOut - b.spentOut, c.spentUsd - b.spentUsd),
  };
}
// Render the all-time counters in Prometheus text exposition format for GET /metrics.
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

function requestHandler(req, res) {
  // /health is always open (liveness/systemd probes); everything else needs the token when one is set.
  if (req.method === 'GET' && req.url.startsWith('/health')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  if (AUTH && req.headers['x-cache-auth'] !== AUTH) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"type":"unauthorized","message":"missing or invalid x-cache-auth"}}'); return; }
  // realtime monitor: hold an SSE stream; broadcast() pushes a line per served call until the client leaves.
  if (req.method === 'GET' && req.url.startsWith('/monitor')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-cache': 'MONITOR' });
    res.write('data: {"type":"connected"}\n\n');
    monitors.add(res);
    res.on('close', () => monitors.delete(res));
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/stats')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(statsObj(), null, 2)); return; }
  if (req.method === 'GET' && req.url.startsWith('/metrics')) { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(prometheus()); return; }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('error', noop);
  req.on('data', (ch) => chunks.push(ch));
  req.on('end', () => {
    const done = handle(req, res, Buffer.concat(chunks));
    /* node:coverage disable */ /* last-resort guard; handle() resolves even on its own errors */
    done.catch((e) => safe(res, () => { res.writeHead(500); res.end(String(e)); }));
    /* node:coverage enable */
  });
}

const createServer = () => http.createServer(requestHandler);

// seed counters, build the server, and listen. Returns the http.Server (callers read .address()).
function start(port = PORT, host = HOST) {
  // Refuse to expose the proxy off-box without an auth token — it spends the real key for any client.
  if (!isLoopbackHost(host) && !AUTH) {
    throw new Error(`refusing to bind non-loopback host "${host}" without CACHE_AUTH_TOKEN (the proxy spends the real API key for any client that can reach it)`);
  }
  seed();
  sessionBase = snapshot();   // freeze the all-time baseline; everything after this counts as "this session"
  const server = createServer();
  server.listen(port, host, () =>
    log(`option-a cache proxy: http://${host}:${port}  (cache ${CACHE_OFF ? 'OFF' : 'ON'}, ttl ${TTL_MS / 1000}s, max ${MAX_ENTRIES}, auth ${AUTH ? 'ON' : 'off'})\n` +
        `  monitor: GET /stats · GET /metrics · seeded ${c.calls} prior calls, $${c.savedUsd.toFixed(4)} saved · coalescing+async-io on`));
  return server;
}

// Pure, side-effect-free routines are exported so they can be imported in tests and
// invoked from the command line (see the CLI dispatch below).
export { requestHandler, createServer, start, usageFrom, priceFor, usd, statsObj };

// Command-line dispatch for the individual routines — every core method is callable
// and testable from the shell: `node proxy-a.mjs <cmd>`. No args => run the server.
/* node:coverage disable */ /* entrypoint CLI; the routines it calls are covered by the test suite */
function cli(args) {
  const [cmd, ...rest] = args;
  if (cmd === 'stats') { seed(); sessionBase = snapshot(); process.stdout.write(JSON.stringify(statsObj(), null, 2) + '\n'); return 0; }
  if (cmd === 'price') { process.stdout.write(JSON.stringify(priceFor(rest[0] || '')) + '\n'); return 0; }
  if (cmd === 'usage') { process.stdout.write(JSON.stringify(usageFrom(rest.join(' '))) + '\n'); return 0; }
  if (cmd === 'key')   { const body = Buffer.from(rest.slice(1).join(' ')); process.stdout.write(crypto.createHash('sha256').update((rest[0] || '') + '\n').update(body).digest('hex') + '\n'); return 0; }
  process.stderr.write('llm-cache-proxy: stats | price <model> | usage <text> | key <model> <body>   (no args: start the server)\n');
  return cmd ? 1 : 0;
}

// True only when this file is the process entry point (node proxy-a.mjs / the bin
// symlink) — not when imported by a test. Portable across Node >=18 (unlike
// import.meta.main, which is Node >=24); realpath resolves the bin symlink.
let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length) process.exit(cli(args));
  if (!REAL_KEY) { console.error('FATAL: ANTHROPIC_API_KEY_REAL not set'); process.exit(1); }
  start();
}
/* node:coverage enable */
