#!/usr/bin/env node
// llm-cache-proxy CLI — cross-platform control (on | off | stop | stats | setup).
// Node equivalent of cachectl-a.sh so `npx llm-cache-proxy on` works everywhere.
// .env search order: ~/.llm-cache-a/.env (npm/Homebrew), then ./.env (source install).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = +(process.env.CACHE_PORT || 4000);
const DIR = path.join(os.homedir(), '.llm-cache-a');
const PIDFILE = path.join(DIR, 'proxy.pid');
const LOG = path.join(DIR, 'proxy.log');
const ENV_FILE = path.join(DIR, '.env');          // canonical home for npm/Homebrew installs
const PROXY = fileURLToPath(new URL('./proxy-a.mjs', import.meta.url));
fs.mkdirSync(DIR, { recursive: true });

// Parse KEY=VALUE lines (optional `export` prefix) into process.env without overwriting set vars.
function parseEnv(text) {
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}

// Load env from ~/.llm-cache-a/.env first, then ./.env (source-install fallback).
function loadEnv() {
  for (const p of [ENV_FILE, path.resolve('.env')]) {
    try { parseEnv(fs.readFileSync(p, 'utf8')); return; } catch {}
  }
}

const get = (p) => new Promise((res) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(b).toString() }));
  }).on('error', () => res(null));
});

async function waitReady(ms = 12000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const r = await get('/health'); if (r && r.status === 200) return true; await new Promise((s) => setTimeout(s, 300)); }
  return false;
}

function stop() {
  try { process.kill(+fs.readFileSync(PIDFILE, 'utf8')); } catch {}
  try { fs.rmSync(PIDFILE); } catch {}
}

// Interactive first-run wizard — writes to ~/.llm-cache-a/.env (chmod 600).
async function setup() {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  console.log('== llm-cache-proxy setup ==');
  console.log(`Writing to: ${ENV_FILE}\n`);

  const key = (await ask('Anthropic API key (sk-ant-...): ')).trim();
  if (!key) { console.error('no key entered — aborting.'); rl.close(); process.exit(1); }

  const port = (await ask('Port [4000]: ')).trim()  || '4000';
  const ttl  = (await ask('Cache TTL seconds [604800]: ')).trim() || '604800';
  const max  = (await ask('Max cache entries [5000]: ')).trim()   || '5000';
  const host = (await ask('Bind host [127.0.0.1]: ')).trim()      || '127.0.0.1';

  rl.close();

  const content = [
    `ANTHROPIC_API_KEY_REAL=${key}`,
    `CACHE_PORT=${port}`,
    `CACHE_TTL_SEC=${ttl}`,
    `CACHE_MAX_ENTRIES=${max}`,
    `CACHE_HOST=${host}`,
    `# CACHE_LOG_LEVEL=info     # silent|error|info|debug`,
    `# CACHE_LOG_FILE=${DIR}/proxy.log   # or 'none'`,
  ].join('\n') + '\n';

  fs.writeFileSync(ENV_FILE, content, { mode: 0o600 });
  console.log(`\nWrote ${ENV_FILE} (chmod 600).`);

  // Expose into current process so start() can use them immediately.
  process.env.ANTHROPIC_API_KEY_REAL = key;
  process.env.CACHE_PORT  = port;
  process.env.CACHE_TTL_SEC = ttl;
  process.env.CACHE_MAX_ENTRIES = max;
  process.env.CACHE_HOST  = host;
}

async function start(off) {
  loadEnv();
  if (!process.env.ANTHROPIC_API_KEY_REAL) {
    if (process.stdin.isTTY) {
      await setup();
    } else {
      console.error(
        'ERROR: ANTHROPIC_API_KEY_REAL not set.\n' +
        `  Run interactively: llm-cache-proxy setup\n` +
        `  Or create: ${ENV_FILE}\n` +
        `  With:      ANTHROPIC_API_KEY_REAL=sk-ant-...`
      );
      process.exit(1);
    }
  }
  stop(); await new Promise((s) => setTimeout(s, 500));
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [PROXY], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, CACHE_OFF: off ? '1' : '' } });
  fs.writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  if (!(await waitReady())) { console.error('proxy did not become ready; see ' + LOG); process.exit(1); }
  console.log(`\nllm-cache-proxy ${off ? '(bypass) ' : ''}ready on http://localhost:${PORT} (pid ${child.pid})`);
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log('  export ANTHROPIC_API_KEY=anything   # client key ignored; .env key is used');
}

async function restart() {
  console.log('Restarting...');
  stop();
  await new Promise((s) => setTimeout(s, 1000));
  await start(false);
}

async function stats() {
  const r = await get('/stats');
  console.log(r && r.status === 200 ? r.body : 'proxy not running (start with: llm-cache-proxy on)');
}

async function validate() {
  let errors = 0, warnings = 0;
  const pass = (msg) => console.log(`  ✓ ${msg}`);
  const fail = (msg) => { errors++; console.log(`  ✗ ${msg}`); };
  const warn = (msg) => { warnings++; console.log(`  ! ${msg}`); };

  console.log('== llm-cache-proxy validate ==\n');
  console.log('Config:');

  loadEnv();

  // .env / key
  const key = process.env.ANTHROPIC_API_KEY_REAL;
  if (!key) {
    fail(`ANTHROPIC_API_KEY_REAL — not set  (run: llm-cache-proxy setup)`);
  } else if (!key.startsWith('sk-ant-')) {
    warn(`ANTHROPIC_API_KEY_REAL set but doesn't look like sk-ant-...`);
  } else {
    pass(`ANTHROPIC_API_KEY_REAL — set (${key.slice(0, 14)}****)`);
  }

  const portVal = +(process.env.CACHE_PORT || 4000);
  if (!Number.isInteger(portVal) || portVal < 1 || portVal > 65535) {
    fail(`CACHE_PORT=${process.env.CACHE_PORT} — not a valid port (1-65535)`);
  } else {
    pass(`CACHE_PORT=${portVal}`);
  }
  pass(`CACHE_HOST=${process.env.CACHE_HOST || '127.0.0.1'}`);
  if (process.env.CACHE_AUTH_TOKEN) pass(`CACHE_AUTH_TOKEN — set (token-gated exposure enabled)`);

  // normalize.json
  const normPath = path.join(DIR, 'normalize.json');
  if (fs.existsSync(normPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(normPath, 'utf8'));
      let ok = true;
      for (const field of ['system_strip', 'message_strip']) {
        if (raw[field] !== undefined && !Array.isArray(raw[field])) {
          fail(`normalize.json — '${field}' must be an array`); ok = false;
        } else if (Array.isArray(raw[field])) {
          for (const p of raw[field]) {
            try { new RegExp(p, 'gs'); }
            catch (e) { fail(`normalize.json — invalid regex in ${field}: ${JSON.stringify(p)}`); ok = false; }
          }
        }
      }
      if (raw.suffix_turns !== undefined && (typeof raw.suffix_turns !== 'number' || raw.suffix_turns < 1)) {
        fail(`normalize.json — suffix_turns must be a positive number`); ok = false;
      }
      if (ok) {
        const sc = (raw.system_strip || []).length, mc = (raw.message_strip || []).length;
        pass(`normalize.json — valid JSON (${sc} system_strip, ${mc} message_strip pattern(s); suffix_only=${!!raw.suffix_only})`);
      }
    } catch (e) { fail(`normalize.json — invalid JSON: ${e.message}`); }
  } else {
    pass(`normalize.json — not present (partial caching disabled)`);
  }

  // prices.json
  const pricesPath = path.join(DIR, 'prices.json');
  if (fs.existsSync(pricesPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
      let ok = true;
      for (const [k, v] of Object.entries(raw)) {
        if (!Array.isArray(v) || v.length !== 2 || v.some(n => typeof n !== 'number')) {
          fail(`prices.json — "${k}" must be [inputPricePerToken, outputPricePerToken]`); ok = false;
        }
      }
      if (ok) pass(`prices.json — valid JSON (${Object.keys(raw).length} model override(s))`);
    } catch (e) { fail(`prices.json — invalid JSON: ${e.message}`); }
  } else {
    pass(`prices.json — not present (built-in haiku/sonnet/opus prices used)`);
  }

  // Runtime checks
  console.log(`\nRuntime (proxy at :${PORT}):`);
  const health = await get('/health');
  if (!health) {
    console.log(`  - proxy not running (skipping runtime checks)`);
  } else if (health.status !== 200) {
    fail(`/health → ${health.status}`);
  } else {
    pass(`/health → 200`);

    const sr = await get('/stats');
    if (!sr || sr.status !== 200) {
      fail(`/stats → ${sr?.status ?? 'no response'}`);
    } else {
      try {
        const s = JSON.parse(sr.body);
        pass(`/stats → 200 (${s.calls} calls, ${s.hits} hits, ${s.hit_rate_pct}% hit rate, cache ${s.cache})`);
      } catch { fail(`/stats → 200 but body is not valid JSON`); }
    }

    const mr = await get('/metrics');
    if (!mr || mr.status !== 200) {
      fail(`/metrics → ${mr?.status ?? 'no response'}`);
    } else if (!mr.body.includes('llm_cache_calls_total')) {
      fail(`/metrics → 200 but missing expected 'llm_cache_calls_total' metric`);
    } else {
      pass(`/metrics → 200 (Prometheus format, expected metrics present)`);
    }
  }

  const summary = errors === 0 && warnings === 0
    ? 'all checks passed ✓'
    : `${errors} error(s), ${warnings} warning(s)`;
  console.log(`\nResult: ${summary}`);
  if (errors > 0) process.exit(1);
}

const cmd = process.argv[2];
if      (cmd === 'on')       start(false);
else if (cmd === 'off')      start(true);
else if (cmd === 'restart')  restart();
else if (cmd === 'stop')     { stop(); console.log('stopped.'); }
else if (cmd === 'stats')    stats();
else if (cmd === 'setup')    { loadEnv(); setup(); }
else if (cmd === 'validate') validate();
else {
  console.log(
    'usage: llm-cache-proxy {on|off|restart|stop|stats|setup|validate}\n' +
    '  on        start with caching enabled  (prompts for key on first run)\n' +
    '  off       start in bypass mode (forward all, cache nothing)\n' +
    '  restart   stop then start\n' +
    '  stop      stop the proxy\n' +
    '  stats     print live tokens/dollars saved\n' +
    '  setup     (re)run the key + settings wizard\n' +
    '  validate  check config files for errors + runtime health (if running)\n' +
    `\nConfig file: ${ENV_FILE}\n` +
    'Docs: https://github.com/mithudso/llm-cache-proxy'
  );
  process.exit(cmd ? 1 : 0);
}
