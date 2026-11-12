#!/usr/bin/env node
// llm-cache-proxy CLI — local start, stop, setup, statistics and validation.
// Node equivalent of cachectl-a.sh so `npx llm-cache-proxy on` works everywhere.
// .env search order: ~/.llm-cache-a/.env (npm/Homebrew), then ./.env (source install).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadEnvFile, writeEnvFile, readControllerConfig, requestLocal, stopProxy } from './lib/controller.mjs';
import { readLimits, validateNormalization, validatePrices } from './lib/proxy-validation.mjs';

const DIR = path.join(os.homedir(), '.llm-cache-a');
const PIDFILE = path.join(DIR, 'proxy.pid');
const LOG = path.join(DIR, 'proxy.log');
const ENV_FILE = path.join(DIR, '.env');          // canonical home for npm/Homebrew installs
const PROXY = fileURLToPath(new URL('./proxy-a.mjs', import.meta.url));
fs.mkdirSync(DIR, { recursive: true });

// Load one configuration file. Explicit environment values take precedence.
function loadEnv() {
  for (const file of [ENV_FILE, path.resolve('.env')]) if (loadEnvFile(file)) break;
}
const get = (route, timeout) => {
  const config = readControllerConfig();
  if (timeout !== undefined) config.timeout = Math.min(config.timeout, timeout);
  return requestLocal(route, config);
};

async function waitReady(child, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try { const response = await get('/health', Math.max(1, deadline - Date.now())); if (response.status === 200) return true; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function stop() { return stopProxy(PIDFILE, PROXY); }

// Interactive first-run wizard — writes to ~/.llm-cache-a/.env (chmod 600).
async function setup() {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = question => new Promise((resolve, reject) => {
    const closed = () => reject(new Error('Setup input closed before all answers were entered'));
    rl.once('close', closed);
    rl.question(question, answer => { rl.removeListener('close', closed); resolve(answer); });
  });

  console.log('== llm-cache-proxy setup ==');
  console.log(`Writing to: ${ENV_FILE}\n`);

  const key = (await ask('Anthropic API key (sk-ant-...): ')).trim();
  if (!key) { console.error('no key entered — aborting.'); rl.close(); process.exit(1); }

  const port = (await ask('Port [4000]: ')).trim()  || '4000';
  const ttl  = (await ask('Cache TTL seconds [604800]: ')).trim() || '604800';
  const max  = (await ask('Max cache entries [5000]: ')).trim()   || '5000';
  const host = (await ask('Bind host [127.0.0.1]: ')).trim()      || '127.0.0.1';

  rl.close();

  if (!/^sk-ant-[A-Za-z0-9_-]+$/.test(key)) throw new Error('API key must use the sk-ant- prefix and contain only letters, digits, underscores or hyphens');
  const values = { ANTHROPIC_API_KEY_REAL: key, CACHE_PORT: port, CACHE_TTL_SEC: ttl, CACHE_MAX_ENTRIES: max, CACHE_HOST: host };
  readControllerConfig(values);
  for (const [name, value] of [['CACHE_TTL_SEC', ttl], ['CACHE_MAX_ENTRIES', max]]) {
    const minimum = name === 'CACHE_TTL_SEC' ? 0 : 1;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) values.CACHE_AUTH_TOKEN = process.env.CACHE_AUTH_TOKEN || randomBytes(24).toString('hex');
  else if (process.env.CACHE_AUTH_TOKEN) values.CACHE_AUTH_TOKEN = process.env.CACHE_AUTH_TOKEN;
  writeEnvFile(ENV_FILE, values);
  Object.assign(process.env, values);
  console.log(`\nWrote ${ENV_FILE} (chmod 600).`);


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
  const config = readControllerConfig();
  readLimits(process.env);
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && !config.token) throw new Error('Non-loopback CACHE_HOST requires CACHE_AUTH_TOKEN');
  stop(); await new Promise((s) => setTimeout(s, 500));
  try {
    await get('/health');
    throw new Error('Configured port already serves another process; refusing to start');
  } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
  const out = fs.openSync(LOG, 'a');
  let child;
  try {
    child = spawn(process.execPath, [PROXY], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, CACHE_OFF: off ? '1' : '' } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { fs.closeSync(out); }
  fs.writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  if (!(await waitReady(child))) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(PIDFILE, { force: true });
    throw new Error('proxy did not become ready; see ' + LOG);
  }
  console.log(`\nllm-cache-proxy ${off ? '(bypass) ' : ''}ready on http://localhost:${readControllerConfig().port} (pid ${child.pid})`);
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${readControllerConfig().port}`);
  console.log('  export ANTHROPIC_API_KEY=anything   # client key ignored; .env key is used');
}

async function restart() {
  console.log('Restarting...');
  await start(false);
}

async function stats() {
  loadEnv();
  const r = await get('/stats');
  if (r.status !== 200) throw new Error(`/stats returned HTTP ${r.status}`);
  console.log(r.body);
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
    pass('ANTHROPIC_API_KEY_REAL — set');
  }

  let config;
  try {
    config = readControllerConfig();
    readLimits(process.env);
    if (!['127.0.0.1', '::1', 'localhost'].includes(config.host) && !config.token) throw new Error('Non-loopback CACHE_HOST requires CACHE_AUTH_TOKEN');
    pass(`CACHE_PORT=${config.port}`);
    pass(`CACHE_HOST=${config.host}`);
    if (config.token) pass('CACHE_AUTH_TOKEN — set (token-gated exposure enabled)');
  } catch (error) { config = null; fail(error.message); }

  // normalize.json
  const normPath = path.join(DIR, 'normalize.json');
  if (fs.existsSync(normPath)) {
    try {
      const parsed = validateNormalization(JSON.parse(fs.readFileSync(normPath, 'utf8')));
      pass(`normalize.json — valid JSON (${parsed.systemRe.length} system_strip, ${parsed.messageRe.length} message_strip pattern(s); suffix_only=${parsed.suffix_only})`);
    } catch (e) { fail(`normalize.json — invalid JSON: ${e.message}`); }
  } else {
    pass(`normalize.json — not present (partial caching disabled)`);
  }

  // prices.json
  const pricesPath = path.join(DIR, 'prices.json');
  if (fs.existsSync(pricesPath)) {
    try {
      const raw = validatePrices(JSON.parse(fs.readFileSync(pricesPath, 'utf8')));
      pass(`prices.json — valid JSON (${Object.keys(raw).length} model override(s))`);
    } catch (e) { fail(`prices.json — invalid JSON: ${e.message}`); }
  } else {
    pass(`prices.json — not present (built-in haiku/sonnet/opus prices used)`);
  }

  // Runtime checks
  if (config) {
    console.log(`\nRuntime (proxy at :${config.port}):`);
    let health;
    try { health = await get('/health'); } catch (error) {
      if (error.code !== 'ECONNREFUSED') { fail('Runtime probe failed: ' + error.message); }
    }
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

  } else console.log('\nRuntime: skipped because configuration is invalid.');

  const summary = errors === 0 && warnings === 0
    ? 'all checks passed ✓'
    : `${errors} error(s), ${warnings} warning(s)`;
  console.log(`\nResult: ${summary}`);
  if (errors > 0) process.exit(1);
}

async function main() {
  const cmd = process.argv[2];
  if      (cmd === 'on')       await start(false);
  else if (cmd === 'off')      await start(true);
  else if (cmd === 'restart')  await restart();
  else if (cmd === 'stop')     { stop(); console.log('stopped.'); }
  else if (cmd === 'stats')    await stats();
  else if (cmd === 'setup')    { loadEnv(); await setup(); }
  else if (cmd === 'validate') await validate();
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

}
main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
