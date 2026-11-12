import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lcp-cli-'));
  const cache = path.join(dir, '.llm-cache-a');
  await fs.mkdir(cache);
  try { return await fn({ dir, cache }); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function run(command, dir, { answers, timeout = 5000, endInput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, command], {
      cwd: dir, env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH },
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (endInput) child.stdin.end();
    let stdout = '', stderr = '', next = 0;
    const prompts = ['Anthropic API key (sk-ant-...): ', 'Port [4000]: ', 'Cache TTL seconds [604800]: ', 'Max cache entries [5000]: ', 'Bind host [127.0.0.1]: '];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${command}; ${stdout}; ${stderr}`)); }, timeout);
    child.stdout.on('data', b => {
      stdout += b;
      if (answers) while (next < answers.length && stdout.includes(prompts[next])) child.stdin.write(answers[next++] + '\n');
    });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
async function withServer(fn, handler, host = '127.0.0.1') {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  try { await fn(server.address().port); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('stats loads the configured port and authenticates protected requests', () => fixture(async ({ dir, cache }) => {
  await withServer(async port => {
    await fs.writeFile(path.join(cache, '.env'), `CACHE_PORT=${port}\nCACHE_AUTH_TOKEN=synthetic-token\n`);
    const r = await run('stats', dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"calls":42/);
  }, (req, res) => {
    assert.equal(req.headers['x-cache-auth'], 'synthetic-token');
    res.end('{"calls":42}');
  });
}));

test('IPv6-only configuration uses the IPv6 loopback address', { skip: process.platform === 'win32' }, () => fixture(async ({ dir, cache }) => {
  await withServer(async port => {
    await fs.writeFile(path.join(cache, '.env'), `CACHE_PORT=${port}\nCACHE_HOST=::1\n`);
    const r = await run('stats', dir);
    assert.match(r.stdout, /ipv6-ready/);
  }, (_req, res) => res.end('ipv6-ready'), '::1');
}));

test('stop rejects an empty pidfile without signaling its process group', { skip: process.platform === 'win32' }, () => fixture(async ({ dir, cache }) => {
  const pidfile = path.join(cache, 'proxy.pid');
  await fs.writeFile(pidfile, '');
  const r = await run('stop', dir);
  assert.equal(r.signal, null);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid.*pid/i);
}));

test('setup repairs an existing config file permission and generates a LAN token', { skip: process.platform === 'win32' }, () => fixture(async ({ dir, cache }) => {
  const envfile = path.join(cache, '.env');
  await fs.writeFile(envfile, '# old config\n', { mode: 0o644 });
  await fs.chmod(envfile, 0o644);
  const r = await run('setup', dir, { answers: ['sk-ant-synthetic', '', '', '', '0.0.0.0'] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await fs.stat(envfile)).mode & 0o777, 0o600);
  const text = await fs.readFile(envfile, 'utf8');
  assert.match(text, /CACHE_AUTH_TOKEN=["']?[a-f0-9]{36,}/);
}));

test('a stalled HTTP response cannot hang the CLI indefinitely', () => fixture(async ({ dir, cache }) => {
  await withServer(async port => {
    await fs.writeFile(path.join(cache, '.env'), `CACHE_PORT=${port}\nCACHE_REQUEST_TIMEOUT_MS=100\n`);
    const r = await run('stats', dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /timeout|timed out/i);
  }, (_req, _res) => {});
}));

test('controller configuration parser treats shell expansion as literal data', async () => {
  const { parseEnvText, serializeEnv } = await import('./lib/controller.mjs');
  const values = { CACHE_LOG_FILE: '/tmp/a #literal "quote" $HOME $(synthetic)', CACHE_AUTH_TOKEN: "quote's-token" };
  assert.deepEqual(parseEnvText(serializeEnv(values)), values);
  assert.deepEqual(parseEnvText("export CACHE_PORT='4001' # port\nCACHE_HOST=::1\n"), { CACHE_PORT: '4001', CACHE_HOST: '::1' });
  assert.throws(() => parseEnvText('INVALID LINE'), /line 1/);
  assert.throws(() => parseEnvText('CACHE_AUTH_TOKEN="a\\nb"'), /line 1/);
  assert.throws(() => serializeEnv({ CACHE_AUTH_TOKEN: 'a\nb' }), /Invalid configuration/);
});

test('PID validation rejects process groups, PID 1, fractions and unsafe integers', async () => {
  const { readProxyPid } = await import('./lib/controller.mjs');
  for (const value of ['', ' ', '0', '1', '-1', '2.5', '42 trailing', '9007199254740992']) assert.throws(() => readProxyPid(value), /Invalid proxy PID/);
  assert.equal(readProxyPid(' 12345\n'), 12345);
});

test('stop preserves a pidfile belonging to another process and never signals it', () => fixture(async ({ cache }) => {
  const { stopProxy } = await import('./lib/controller.mjs');
  const pidfile = path.join(cache, 'proxy.pid');
  await fs.writeFile(pidfile, '12345');
  let signaled = false;
  assert.throws(() => stopProxy(pidfile, '/repo/proxy-a.mjs', { readCommand: () => '/usr/bin/node /other/task.mjs', signal: () => { signaled = true; } }), /another process/);
  assert.equal(signaled, false);
  assert.equal(await fs.readFile(pidfile, 'utf8'), '12345');
}));

test('stop verifies the exact proxy command before signaling and removes its pidfile', () => fixture(async ({ cache }) => {
  const { stopProxy } = await import('./lib/controller.mjs');
  const pidfile = path.join(cache, 'proxy.pid');
  await fs.writeFile(pidfile, '12345');
  const signals = [];
  assert.equal(stopProxy(pidfile, '/repo/proxy-a.mjs', { readCommand: () => `${process.execPath} /repo/proxy-a.mjs`, signal: pid => signals.push(pid) }), true);
  assert.deepEqual(signals, [12345]);
  await assert.rejects(fs.stat(pidfile), { code: 'ENOENT' });
}));

test('an aborted local response settles with an error', async () => {
  const { requestLocal } = await import('./lib/controller.mjs');
  await withServer(async port => {
    await assert.rejects(requestLocal('/stats', { requestHost: '127.0.0.1', port, token: '', timeout: 500 }), /aborted|socket hang up/);
  }, (_req, res) => { res.writeHead(200, { 'content-length': '500' }); res.write('partial'); res.socket.destroy(); });
});

test('setup rejects invalid numeric settings before replacing credentials', () => fixture(async ({ dir, cache }) => {
  const envfile = path.join(cache, '.env');
  await fs.writeFile(envfile, 'ANTHROPIC_API_KEY_REAL="sk-ant-original"\n');
  const r = await run('setup', dir, { answers: ['sk-ant-synthetic', 'not-a-port', '', '', ''] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CACHE_PORT/);
  assert.match(await fs.readFile(envfile, 'utf8'), /sk-ant-original/);
}));

test('setup refuses a symlink credential destination', () => fixture(async ({ dir, cache }) => {
  const target = path.join(dir, 'unrelated');
  await fs.writeFile(target, 'unchanged');
  await fs.symlink(target, path.join(cache, '.env'));
  // The symlink contains valid configuration so loading does not fail before the write guard.
  await fs.writeFile(target, '# unchanged\n');
  const r = await run('setup', dir, { answers: ['sk-ant-synthetic', '', '', '', ''] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), '# unchanged\n');
}));

test('installed CLI starts and stops its own isolated proxy', { skip: process.platform === 'win32' }, () => fixture(async ({ dir, cache }) => {
  const allocator = http.createServer();
  await new Promise(resolve => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise(resolve => allocator.close(resolve));
  await fs.writeFile(path.join(cache, '.env'), `ANTHROPIC_API_KEY_REAL="sk-ant-synthetic"\nCACHE_PORT=${port}\nCACHE_AUTH_TOKEN="synthetic-token"\n`);
  let pid;
  try {
    const started = await run('on', dir);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`ready on http://localhost:${port}`));
    pid = Number(await fs.readFile(path.join(cache, 'proxy.pid'), 'utf8'));
    const stats = await run('stats', dir);
    assert.equal(stats.code, 0, stats.stderr);
    assert.equal(JSON.parse(stats.stdout).calls, 0);
    const stopped = await run('stop', dir);
    assert.equal(stopped.code, 0, stopped.stderr);
    await assert.rejects(fs.stat(path.join(cache, 'proxy.pid')), { code: 'ENOENT' });
  } finally {
    // This PID comes only from the disposable proxy created by this test.
    if (!pid) try { pid = Number(await fs.readFile(path.join(cache, 'proxy.pid'), 'utf8')); } catch {}
    if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid); } catch {}
  }
}));

for (const [name, file, value] of [
  ['invalid suffix configuration', 'normalize.json', { suffix_only: 'false', suffix_turns: 1.5 }],
  ['negative model prices', 'prices.json', { test: [-1, 2] }],
]) test(`validate rejects ${name} consistently with startup`, () => fixture(async ({ dir, cache }) => {
  await withServer(async port => {
    await fs.writeFile(path.join(cache, '.env'), `ANTHROPIC_API_KEY_REAL="sk-ant-synthetic"\nCACHE_PORT=${port}\n`);
    await fs.writeFile(path.join(cache, file), JSON.stringify(value));
    const result = await run('validate', dir);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp(file.replace('.', '\\.')));
  }, (req, res) => {
    res.end(req.url === '/metrics' ? 'llm_cache_calls_total 0' : req.url === '/stats' ? '{"calls":0,"hits":0,"hit_rate_pct":0,"cache":"on"}' : '{"status":"ok"}');
  });
}));

test('validate rejects invalid proxy limits before probing any endpoint', () => fixture(async ({ dir, cache }) => {
  await fs.writeFile(path.join(cache, '.env'), 'ANTHROPIC_API_KEY_REAL="sk-ant-synthetic"\nCACHE_MAX_REQUEST_BYTES=0\n');
  const result = await run('validate', dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CACHE_MAX_REQUEST_BYTES/);
  assert.match(result.stdout, /Runtime: skipped/);
}));

test('start refuses an occupied port instead of reporting another server as ready', () => fixture(async ({ dir, cache }) => {
  await withServer(async port => {
    await fs.writeFile(path.join(cache, '.env'), `ANTHROPIC_API_KEY_REAL="sk-ant-synthetic"\nCACHE_PORT=${port}\n`);
    const result = await run('on', dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already serves another process/);
    await assert.rejects(fs.stat(path.join(cache, 'proxy.pid')), { code: 'ENOENT' });
  }, (_req, res) => res.end('{"status":"ok"}'));
}));

test('setup reports closed input as failure without writing credentials', () => fixture(async ({ dir, cache }) => {
  const result = await run('setup', dir, { endInput: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /input closed/i);
  await assert.rejects(fs.stat(path.join(cache, '.env')), { code: 'ENOENT' });
}));
