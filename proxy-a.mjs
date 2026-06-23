#!/usr/bin/env node
// Option A — zero-dependency byte-exact Anthropic caching proxy.
// Exact-match full-call cache: identical /v1/messages body -> replay stored bytes,
// no upstream call (100% token save). Streaming SSE + tool_use preserved verbatim.
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
const TTL_MS = +(process.env.CACHE_TTL_SEC || 604800) * 1000;   // 7d
const MAX_ENTRIES = +(process.env.CACHE_MAX_ENTRIES || 5000);
const DIR = path.join(os.homedir(), '.llm-cache-a');
const ENTRIES = path.join(DIR, 'entries');
const METRICS = path.join(DIR, 'metrics.jsonl');
fs.mkdirSync(ENTRIES, { recursive: true });

if (!REAL_KEY) { console.error('FATAL: ANTHROPIC_API_KEY_REAL not set'); process.exit(1); }

const keyFor = (body, model) =>
  crypto.createHash('sha256').update(model + '\n').update(body).digest('hex');
const metric = (o) => { try { fs.appendFileSync(METRICS, JSON.stringify({ t: Date.now(), ...o }) + '\n'); } catch {} };

function usageFrom(text) {
  // best-effort: input from first usage block, output = last output_tokens seen
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
  if (Date.now() - m.ts >= TTL_MS) return false;          // expired
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': m.contentType || 'application/json', 'x-cache': 'HIT' });
  res.end(buf);
  fs.utimesSync(file, new Date(), new Date());             // LRU touch
  metric({ event: 'hit', model: m.model, bytes: buf.length, in: m.usage?.input_tokens || 0, out: m.usage?.output_tokens || 0 });
  return true;
}

function handle(req, res, body) {
  let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch {}
  const model = parsed.model || '';
  const wantsStream = parsed.stream === true;
  const k = keyFor(body, model);
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
  delete headers['accept-encoding'];                          // force plaintext SSE
  headers['content-length'] = Buffer.byteLength(body);

  const up = https.request({ host: UPSTREAM, port: 443, path: req.url, method: 'POST', headers }, (ur) => {
    res.writeHead(ur.statusCode, { ...ur.headers, 'x-cache': 'MISS' });
    const parts = [];
    ur.on('data', c => { parts.push(c); res.write(c); });
    ur.on('end', () => {
      res.end();
      const buf = Buffer.concat(parts);
      const text = buf.toString('utf8');
      const complete = ur.statusCode === 200 &&
        (!wantsStream || text.includes('message_stop'));      // only cache clean, complete 200s
      if (complete && !bypass) {
        try {
          fs.writeFileSync(file, buf);
          fs.writeFileSync(meta, JSON.stringify({
            ts: Date.now(), model, contentType: ur.headers['content-type'] || 'application/json',
            usage: usageFrom(text),
          }));
          prune();
        } catch {}
      }
      metric({ event: 'miss', model, status: ur.statusCode, bytes: buf.length, cached: complete });
    });
  });
  up.on('error', (e) => {                                     // fail-open: never break the client
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json', 'x-cache': 'ERROR' });
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(e) } }));
    metric({ event: 'error', model, err: String(e) });
  });
  up.write(body); up.end();
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return;
  }
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => handle(req, res, Buffer.concat(chunks)));
});
// Default dual-stack bind (::) accepts BOTH localhost(::1) and 127.0.0.1 —
// avoids the IPv4-only `localhost` failure that broke the litellm attempt.
server.listen(PORT, () =>
  console.log(`option-a cache proxy: http://localhost:${PORT}  (cache ${CACHE_OFF ? 'OFF' : 'ON'}, ttl ${TTL_MS / 1000}s, max ${MAX_ENTRIES})`));
