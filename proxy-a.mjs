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
import { limits } from './lib/proxy-config.mjs';
import { validatePrices, validateNormalization } from './lib/proxy-validation.mjs';

const PORT = limits.port;
// Bind address. Loopback by default (the proxy spends the real key for ANY client,
// so it must not be reachable off-box unless you opt in). Set CACHE_HOST to a LAN
// address / 0.0.0.0 to expose it — which then REQUIRES CACHE_AUTH_TOKEN (see start()).
const HOST = process.env.CACHE_HOST || '127.0.0.1';
const AUTH = process.env.CACHE_AUTH_TOKEN || '';
const isLoopbackHost = (h) => ['127.0.0.1', '::1', 'localhost'].includes(h);
/* node:coverage disable */ /* production upstream defaults; tests always set CACHE_UPSTREAM_* */
const UPSTREAM = process.env.CACHE_UPSTREAM_HOST || 'api.anthropic.com';
const UPSTREAM_PORT = limits.upstreamPort;
// production talks HTTPS to Anthropic; tests point this at a local HTTP mock via CACHE_UPSTREAM_PROTO=http
const UPSTREAM_AGENT = process.env.CACHE_UPSTREAM_PROTO === 'http' ? http : https;
/* node:coverage enable */
const REAL_KEY = process.env.ANTHROPIC_API_KEY_REAL;
const CACHE_OFF = process.env.CACHE_OFF === '1';
const QUIET = process.env.CACHE_QUIET === '1';
const TTL_MS = limits.ttlMs;
const MAX_ENTRIES = limits.maxEntries;
const DIR = path.join(os.homedir(), '.llm-cache-a');
const ENTRIES = path.join(DIR, 'entries');
const METRICS = path.join(DIR, 'metrics.jsonl');
// Log verbosity: silent<error<info<debug. CACHE_QUIET=1 stays as an alias for silent.
const LOG_LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.CACHE_LOG_LEVEL] ?? (QUIET ? 0 : 2);
// Default log file (in addition to stdout). Set CACHE_LOG_FILE=none to disable, or a path to override.
const LOG_FILE = process.env.CACHE_LOG_FILE === 'none' ? '' : (process.env.CACHE_LOG_FILE || path.join(DIR, 'proxy.log'));
fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(ENTRIES, { recursive: true, mode: 0o700 });

// ---- pricing: $ per token [input, output]; matched by substring on the model id ----
const PRICES = Object.assign(Object.create(null), { haiku: [0.8e-6, 4e-6], sonnet: [3e-6, 15e-6], opus: [15e-6, 75e-6] });
const DEFAULT_PRICE = [15e-6, 75e-6];
const configWarnings = [];
try { Object.assign(PRICES, validatePrices(JSON.parse(fs.readFileSync(path.join(DIR, 'prices.json'), 'utf8')))); }
catch (error) { if (error.code !== 'ENOENT') configWarnings.push('CONFIG_INVALID prices.json; using built-in prices'); }
// Prefer a full model override to a broad family substring, regardless of insertion order.
const PRICE_ENTRIES = Object.entries(PRICES).sort(([a], [b]) => b.length - a.length);
const priceFor = (m) => { m = typeof m === 'string' ? m.toLowerCase() : ''; for (const [k, price] of PRICE_ENTRIES) if (m.includes(k)) return price; return DEFAULT_PRICE; };
const usd = (m, i, o) => { const [pi, po] = priceFor(m); return i * pi + o * po; };

// ---- partial / normalized caching (optional; ~/.llm-cache-a/normalize.json) ----
// When loaded, two additional cache-key tiers are attempted on exact-key miss:
//   HIT-NORM   — full conversation, but dynamic fields stripped (timestamps, session IDs, etc.)
//   HIT-SUFFIX — suffix_only:true only; ignores old history, keys on last suffix_turns messages
// Both tiers also cause a MISS to write alias files so future requests can hit.
let NORM_PATTERNS = null;
try {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'normalize.json'), 'utf8'));
  NORM_PATTERNS = validateNormalization(raw);
} catch (error) { if (error.code !== 'ENOENT') configWarnings.push('CONFIG_INVALID normalize.json; normalized caching disabled'); }

// Returns a shallow-cloned parsed body with dynamic fields stripped per NORM_PATTERNS.
function normalizeBody(parsed) {
  const out = { ...parsed };
  if (typeof out.system === 'string')
    for (const re of NORM_PATTERNS.systemRe) out.system = out.system.replace(re, '<NORM>');
  if (Array.isArray(out.messages))
    out.messages = out.messages.map((msg) => {
      if (typeof msg.content !== 'string') return msg;
      let c = msg.content;
      for (const re of NORM_PATTERNS.messageRe) c = c.replace(re, '<NORM>');
      return c === msg.content ? msg : { ...msg, content: c };
    });
  return out;
}

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
      if (!r || typeof r !== 'object' || (r.model !== undefined && typeof r.model !== 'string') ||
          [r.in, r.out].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) continue;
      if (r.event === 'hit') { applyHit(r.model, r.in || 0, r.out || 0); if (r.coalesced) c.coalesced++; }
      else if (r.event === 'miss') applyMiss(r.model, r.in || 0, r.out || 0);
      else if (r.event === 'error') { c.calls++; c.errors++; }
    }
  } catch {}
}

/* node:coverage disable */ /* swallows fire-and-forget I/O errors; only runs on rare disk/socket failure */
const noop = () => {};
/* node:coverage enable */
const metric = (o) => { fsp.appendFile(METRICS, JSON.stringify({ t: Date.now(), ...o }) + '\n', { mode: 0o600 }).catch(noop); };
// Emit a log line at the given level (default info) to stdout + the log file, if verbosity allows.
const log = (s, level = LOG_LEVELS.info) => {
  if (level > LOG_LEVEL) return;
  const line = `${new Date().toISOString()}  ${s}`;   // timestamp every line (stdout + file + status tail)
  process.stdout.write(line + '\n');
  if (LOG_FILE) fsp.appendFile(LOG_FILE, line + '\n', { mode: 0o600 }).catch(noop);
};
for (const warning of configWarnings) log(warning, LOG_LEVELS.error);
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
  const im = text.match(/"input_tokens"\s*:\s*(\d+)/); if (im) i = +im[1];
  const om = [...text.matchAll(/"output_tokens"\s*:\s*(\d+)/g)]; if (om.length) o = +om[om.length - 1][1];
  return { input_tokens: i, output_tokens: o };
}

function hasTerminalEvent(text) {
  const frames = text.split(/\r?\n\r?\n/);
  // An unterminated frame after message_stop is still an incomplete stream.
  if (frames.pop().trim()) return false;
  let lastEvent = '';
  for (const frame of frames) {
    const match = frame.match(/(?:^|\r?\n)event:[ \t]*([^\r\n]*)/);
    if (match) lastEvent = match[1].trim();
  }
  return lastEvent === 'message_stop';
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
    const excess = Math.max(0, ranked.length - MAX_ENTRIES);
    for (const { f } of ranked.slice(0, excess)) {
      await fsp.rm(path.join(ENTRIES, f), { force: true }).catch(noop);
      await fsp.rm(path.join(ENTRIES, f.replace(/\.bin$/, '.json')), { force: true }).catch(noop);
    }
    // Invalidations and overwrites can make the estimate stale. Count actual files.
    entryCount = (await fsp.readdir(ENTRIES)).filter(f => f.endsWith('.bin')).length;
  /* node:coverage disable */ /* defensive: prune failures must never throw */
  } catch {} /* node:coverage enable */ finally { pruning = false; }
}

// Load a cached entry if its meta exists and is within TTL; touch it for LRU. Null = miss/expired.
function validMetadata(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || !Number.isSafeInteger(m.ts) || m.ts < 0 || m.ts > Date.now()) return false;
  if (m.model !== undefined && (typeof m.model !== 'string' || m.model.length > 200 || /[\x00-\x1f\x7f]/.test(m.model))) return false;
  if (m.bodyHash !== undefined && (typeof m.bodyHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.bodyHash))) return false;
  if (m.usage !== undefined && (!m.usage || typeof m.usage !== 'object' || Array.isArray(m.usage) ||
      [m.usage.input_tokens, m.usage.output_tokens].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0)))) return false;
  for (const [key, name] of [['contentType', 'content-type'], ['contentEncoding', 'content-encoding']]) {
    if (m[key] === undefined) continue;
    if (typeof m[key] !== 'string' || m[key].length === 0 || m[key].length > 1024) return false;
    try { http.validateHeaderValue(name, m[key]); } catch { return false; }
  }
  return true;
}

async function readHit(file, meta) {
  if ((await fsp.stat(meta)).size > 8192) return null;
  const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
  if (!validMetadata(m)) return null;
  if (Date.now() - m.ts >= TTL_MS) return null;             // expired
  if ((await fsp.stat(file)).size > limits.maxResponseBytes) return null;
  const buf = await fsp.readFile(file);
  if (m.bodyHash && crypto.createHash('sha256').update(buf).digest('hex') !== m.bodyHash) return null;
  fsp.utimes(file, new Date(), new Date()).catch(noop);  // LRU touch (fire-and-forget)
  return { m, buf };
}

// Replay a cached payload to the client byte-for-byte, update hit counters, log, and broadcast.
function serveHit(res, m, buf, label, seq) {
  const headers = { 'content-type': m.contentType || 'application/json', 'x-cache': label };
  if (m.contentEncoding) headers['content-encoding'] = m.contentEncoding;
  safe(res, () => { res.writeHead(200, headers); res.end(buf); });
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

const inflight = new Map();   // key -> { promise, waiters, abortWhenUnused }

// Legacy body-only keys remain valid for the default route without API headers.
// Other HTTP representations get a separate namespace at every cache tier.
function cacheKey(req, model, body) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.startsWith('anthropic-') || ['content-encoding', 'accept'].includes(name) || (name === 'content-type' && req.headers[name] !== 'application/json')).sort(([a], [b]) => a.localeCompare(b)));
  const context = req.url !== '/v1/messages' || Object.keys(headers).length ? JSON.stringify({ url: req.url, headers }) + '\n' : '';
  return crypto.createHash('sha256').update(context + model + '\n').update(body).digest('hex');
}

// Publishing the body and metadata by rename keeps partial files invisible. A
// digest in the metadata rejects the brief old/new pair window during alias writes.
async function writeEntry(file, meta, buf, metaJson) {
  const suffix = `.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const bodyTmp = file + suffix, metaTmp = meta + suffix;
  try {
    await fsp.writeFile(bodyTmp, buf, { flag: 'wx', mode: 0o600 });
    await fsp.writeFile(metaTmp, metaJson, { flag: 'wx', mode: 0o600 });
    await fsp.rename(bodyTmp, file);
    await fsp.rename(metaTmp, meta);
  } finally {
    await Promise.all([fsp.rm(bodyTmp, { force: true }), fsp.rm(metaTmp, { force: true })]).catch(noop);
  }
}

// ---- realtime monitor: GET /monitor holds an SSE stream; every served call is broadcast live ----
const monitors = new Set();   // open /monitor response objects
let callSeq = 0;              // monotonic per-process call counter, included in every broadcast event
const broadcast = (ev) => {
  if (!monitors.size) return;
  const line = `data: ${JSON.stringify({ t: Date.now(), ...ev })}\n\n`;
  for (const m of monitors) safe(m, () => { if (!m.write(line)) m.destroy(); });
};

// Core request path: hash the body to a key, then try disk-cache → coalesce → upstream fetch.
async function handle(req, res, body) {
  if (res.destroyed || res.writableEnded) return;
  const seq = ++callSeq;
  let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed.model !== undefined && (typeof parsed.model !== 'string' || parsed.model.length > 200 || /[\x00-\x1f\x7f]/.test(parsed.model))) ||
      (parsed.messages !== undefined && (!Array.isArray(parsed.messages) || parsed.messages.some(msg => !msg || typeof msg !== 'object' || Array.isArray(msg))))) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"invalid_request_error","message":"invalid model or messages shape"}}');
    return;
  }
  const model = parsed.model || '';
  const wantsStream = parsed.stream === true;
  const key = cacheKey(req, model, body);
  const file = path.join(ENTRIES, key + '.bin');
  const meta = path.join(ENTRIES, key + '.json');
  const bypass = CACHE_OFF || req.headers['x-cache-bypass'] === '1';
  log(`DEBUG ${model || '?'} key=${key.slice(0, 12)} stream=${wantsStream}${bypass ? ' bypass' : ''}`, LOG_LEVELS.debug);

  // Pre-compute alias keys (normalize + suffix) so MISS writes under them too.
  let normKey = null, sufKey = null;
  const aliasKeys = [];
  if (!bypass && NORM_PATTERNS) {
    const normed = normalizeBody(parsed);
    const normBuf = Buffer.from(JSON.stringify(normed));
    const nk = cacheKey(req, model, normBuf);
    if (nk !== key) { normKey = nk; aliasKeys.push(nk); }
    if (NORM_PATTERNS.suffix_only) {
      const sufMsgs = (normed.messages || []).slice(-NORM_PATTERNS.suffix_turns);
      const sufBuf = Buffer.from(JSON.stringify({ ...normed, messages: sufMsgs }));
      const sk = cacheKey(req, model, sufBuf);
      if (sk !== key && sk !== nk) { sufKey = sk; aliasKeys.push(sk); }
    }
  }

  // 1) disk cache hit (exact → normalized → suffix)
  if (!bypass) {
    try { const h = await readHit(file, meta); if (h) { serveHit(res, h.m, h.buf, 'HIT', seq); return; } } catch {}
    if (normKey) {
      try { const h = await readHit(path.join(ENTRIES, normKey + '.bin'), path.join(ENTRIES, normKey + '.json')); if (h) { serveHit(res, h.m, h.buf, 'HIT-NORM', seq); return; } } catch {}
    }
    if (sufKey) {
      try { const h = await readHit(path.join(ENTRIES, sufKey + '.bin'), path.join(ENTRIES, sufKey + '.json')); if (h) { serveHit(res, h.m, h.buf, 'HIT-SUFFIX', seq); return; } } catch {}
    }
  }

  // 2) coalesce onto an in-flight identical fetch (no second upstream call)
  if (res.destroyed || res.writableEnded) return;
  if (!bypass && inflight.has(key)) {
    const entry = inflight.get(key);
    entry.waiters++;
    let waiting = true;
    const release = () => { if (waiting) { waiting = false; entry.waiters--; entry.abortWhenUnused(); } };
    res.once('close', release);
    try {
      const r = await entry.promise;
      if (res.destroyed || res.writableEnded) return;
      if (r && r.complete) { serveHit(res, { contentType: r.contentType, contentEncoding: r.contentEncoding, model: r.model, usage: r.usage }, r.buf, 'HIT-COALESCED', seq); return; }
      // first fetch was non-200/errored: replay its status+body so the waiter sees the same result
      if (r) { safe(res, () => { res.writeHead(r.status, { ...r.headers, 'content-type': r.contentType, 'x-cache': 'MISS-COALESCED' }); res.end(r.buf); }); broadcast({ seq, type: 'MISS-COALESCED', from_cache: false, model: r.model, status: r.status }); return; }
    } catch {} finally { release(); res.removeListener('close', release); }
    // fall through to own fetch if the shared one rejected
  }

  // 3) MISS — fetch upstream, stream live to THIS client, share the result via inflight
  if (res.destroyed || res.writableEnded) return;
  const entry = { waiters: 0, promise: null, abortWhenUnused: noop };
  const p = fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass, seq, aliasKeys, entry);
  entry.promise = p;
  if (!bypass) { inflight.set(key, entry); p.finally(() => { if (inflight.get(key) === entry) inflight.delete(key); }); }
  await p.catch(noop);
}

// Remove connection-specific headers before injecting the proxy's own credentials.
function endToEndHeaders(source) {
  const headers = { ...source };
  const named = String(headers.connection || '').split(',').map(name => name.trim().toLowerCase());
  for (const name of [...named, 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete headers[name];
  return headers;
}

// Stream to the primary client and resolve a replayable result for waiters.
// Return null only when the response exceeds retained capacity; failures resolve
// a structured error result. aliasKeys publish normalized/suffix copies as well.
function fetchUpstream(req, res, body, model, wantsStream, file, meta, bypass, seq, aliasKeys = [], entry) {
  return new Promise((resolve) => {
    const headers = endToEndHeaders(req.headers);
    headers.host = UPSTREAM;
    headers['x-api-key'] = REAL_KEY;
    for (const name of ['authorization', 'accept-encoding', 'x-cache-auth', 'x-cache-bypass']) delete headers[name];
    headers['content-length'] = body.length;

    const t0 = Date.now();
    let settled = false, upstreamEnded = false, up, ur, deadline;
    const onAbort = () => {
      if (!upstreamEnded && !settled && res.destroyed && entry.waiters === 0) fail('CLIENT_ABORTED', 502);
      else if (res.destroyed) ur?.resume();
    };
    entry.abortWhenUnused = onAbort;
    const cleanup = () => { clearTimeout(deadline); res.removeListener('close', onAbort); };
    const fail = (code, status = 502) => {
      if (settled) return;
      settled = true;
      cleanup();
      up?.destroy();
      ur?.destroy();
      const buf = Buffer.from(JSON.stringify({ error: { type: 'proxy_error', message: code } }));
      safe(res, () => {
        if (res.headersSent) res.destroy();
        else { res.writeHead(status, { 'content-type': 'application/json', 'x-cache': 'ERROR' }); res.end(buf); }
      });
      c.calls++; c.errors++;
      metric({ event: 'error', model, err: code });
      log(`ERR           ${model || '?'}  ${code}`, LOG_LEVELS.error);
      broadcast({ seq, type: 'ERROR', from_cache: false, model, err: code });
      resolve({ status, contentType: 'application/json', headers: {}, buf, model, complete: false });
    };
    res.once('close', onAbort);
    res.on('error', noop);
    req.on('error', noop);
    deadline = setTimeout(() => fail('UPSTREAM_TIMEOUT', 504), limits.upstreamTimeoutMs);
    deadline.unref();
    try {
      up = UPSTREAM_AGENT.request({ host: UPSTREAM, port: UPSTREAM_PORT, path: req.url, method: 'POST', headers }, response => {
        ur = response;
        const responseHeaders = endToEndHeaders(ur.headers);
        safe(res, () => res.writeHead(ur.statusCode, { ...responseHeaders, 'x-cache': 'MISS' }));
        let parts = [], bytes = 0, retained = true, usageTail = '';
        let usage = { input_tokens: 0, output_tokens: 0 };
        ur.on('error', () => fail('UPSTREAM_RESPONSE_ERROR'));
        ur.on('aborted', () => fail('UPSTREAM_RESPONSE_ABORTED'));
        ur.on('close', () => { if (!upstreamEnded && !ur.complete) fail('UPSTREAM_RESPONSE_CLOSED'); });
        ur.on('data', ch => {
          bytes += ch.length;
          if (retained && bytes <= limits.maxResponseBytes) parts.push(ch);
          else { retained = false; parts = []; }
          usageTail = (usageTail + ch.toString('utf8')).slice(-8192);
          const found = usageFrom(usageTail);
          if (found.input_tokens) usage.input_tokens = found.input_tokens;
          if (found.output_tokens) usage.output_tokens = found.output_tokens;
          safe(res, () => {
            if (!res.write(ch)) {
              ur.pause();
              res.once('drain', () => ur.resume());
            }
          });
        });
        ur.on('end', () => {
          upstreamEnded = true;
          cleanup();
          safe(res, () => res.end());
          (async () => {
            const buf = retained ? Buffer.concat(parts) : null;
            const text = buf?.toString('utf8') || '';
            if (retained) usage = usageFrom(text);
            const contentType = ur.headers['content-type'] || 'application/json';
            const contentEncoding = ur.headers['content-encoding'];
            // A terminal SSE event must occupy its own event field and finish a frame.
            const streaming = wantsStream || contentType.includes('text/event-stream');
            const complete = retained && ur.statusCode === 200 && (!streaming || hasTerminalEvent(text));
            let stored = false;
            if (complete && !bypass) {
              try {
                const metaJson = JSON.stringify({ ts: Date.now(), model, contentType, contentEncoding, usage, bodyHash: crypto.createHash('sha256').update(buf).digest('hex') });
                await writeEntry(file, meta, buf, metaJson);
                for (const ak of aliasKeys) await writeEntry(path.join(ENTRIES, ak + '.bin'), path.join(ENTRIES, ak + '.json'), buf, metaJson);
                stored = true;
                if (entryCount !== null) entryCount += 1 + aliasKeys.length;
                maybePrune();
              } catch { log('CACHE_WRITE_FAILED response forwarded without caching', LOG_LEVELS.error); }
            }
            applyMiss(model, usage.input_tokens, usage.output_tokens);
            const d = usd(model, usage.input_tokens, usage.output_tokens);
            metric({ event: 'miss', model, status: ur.statusCode, bytes, in: usage.input_tokens, out: usage.output_tokens, usd: d, cached: stored });
            log(`MISS          ${model || '?'}  ${ur.statusCode}  ${usage.input_tokens + usage.output_tokens}tok $${d.toFixed(5)}  ${Date.now() - t0}ms${stored ? ' [cached]' : ''}  | spend $${c.spentUsd.toFixed(4)}`);
            let monExtra = {};
            if (!wantsStream && ur.statusCode === 200 && retained) {
              try { const snip = JSON.parse(text).content?.[0]?.text?.slice(0, 80); if (snip != null) monExtra = { snippet: snip }; } catch {}
            }
            broadcast({ seq, type: 'MISS', from_cache: false, stored, model, status: ur.statusCode, in: usage.input_tokens, out: usage.output_tokens, usd: d, ms: Date.now() - t0, ...monExtra });
            settled = true;
            // Oversized responses still stream intact. Waiters fetch separately because
            // replaying them would require retaining an unbounded response in memory.
            resolve(retained ? { status: ur.statusCode, contentType, contentEncoding, headers: responseHeaders, buf, model, usage, complete } : null);
          })().catch(() => fail('UPSTREAM_PROCESSING_ERROR'));
        });
      });
      up.on('error', () => fail('UPSTREAM_REQUEST_ERROR'));
      up.end(body);
    } catch { fail('UPSTREAM_REQUEST_ERROR'); }
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
  const pathname = req.url.split('?')[0];
  // /health is always open (liveness/systemd probes); everything else needs the token when one is set.
  if (req.method === 'GET' && pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  if (AUTH && req.headers['x-cache-auth'] !== AUTH) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"type":"unauthorized","message":"missing or invalid x-cache-auth"}}'); return; }
  // realtime monitor: hold an SSE stream; broadcast() pushes a line per served call until the client leaves.
  if (req.method === 'GET' && pathname === '/monitor') {
    if (monitors.size >= limits.maxMonitors) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-cache': 'MONITOR' });
    res.write('data: {"type":"connected"}\n\n');
    monitors.add(res);
    res.on('close', () => monitors.delete(res));
    return;
  }
  if (req.method === 'GET' && pathname === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(statsObj(), null, 2)); return; }
  if (req.method === 'GET' && pathname === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(prometheus()); return; }
  if (req.method !== 'POST' || pathname !== '/v1/messages') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  let bytes = 0, oversized = false;
  req.on('error', noop);
  req.on('data', ch => {
    if (oversized) return;
    bytes += ch.length;
    if (bytes > limits.maxRequestBytes) {
      oversized = true;
      chunks.length = 0;
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"error":{"type":"request_too_large"}}');
      log('REQUEST_TOO_LARGE request rejected before upstream', LOG_LEVELS.error);
      return;
    }
    chunks.push(ch);
  });
  req.on('end', () => {
    if (oversized) return;
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
