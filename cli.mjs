#!/usr/bin/env node
// llm-cache-proxy CLI — cross-platform control (on | off | stop | stats).
// Node equivalent of cachectl-a.sh so `npx llm-cache-proxy on` works everywhere.
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
const PROXY = fileURLToPath(new URL('./proxy-a.mjs', import.meta.url));
fs.mkdirSync(DIR, { recursive: true });

// Load ./.env (KEY=VALUE lines, optional `export` prefix) into process.env without overwriting existing vars.
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {}
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

async function start(off) {
  loadEnv();
  if (!process.env.ANTHROPIC_API_KEY_REAL) {
    console.error('ERROR: ANTHROPIC_API_KEY_REAL not set. Put it in ./.env or export it.'); process.exit(1);
  }
  stop(); await new Promise((s) => setTimeout(s, 500));
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [PROXY], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, CACHE_OFF: off ? '1' : '' } });
  fs.writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  if (!(await waitReady())) { console.error('proxy did not become ready; see ' + LOG); process.exit(1); }
  console.log(`llm-cache-proxy ${off ? '(bypass) ' : ''}ready on http://localhost:${PORT} (pid ${child.pid})`);
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log('  export ANTHROPIC_API_KEY=anything   # client key ignored; .env key is used');
}

async function stats() {
  const r = await get('/stats');
  console.log(r && r.status === 200 ? r.body : 'proxy not running (start with: llm-cache-proxy on)');
}

const cmd = process.argv[2];
if (cmd === 'on') start(false);
else if (cmd === 'off') start(true);
else if (cmd === 'stop') { stop(); console.log('stopped.'); }
else if (cmd === 'stats') stats();
else {
  console.log('usage: llm-cache-proxy {on|off|stop|stats}\n' +
    '  on     start with caching enabled\n' +
    '  off    start in bypass mode (forward all, cache nothing)\n' +
    '  stop   stop the proxy\n' +
    '  stats  print live tokens/dollars saved\n' +
    '\nNeeds ANTHROPIC_API_KEY_REAL in ./.env or the environment.');
  process.exit(cmd ? 1 : 0);
}
