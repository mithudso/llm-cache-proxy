// Local controller primitives. Configuration is data; never evaluate .env text.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function parseEnvText(text) {
  const values = {};
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) throw new Error(`Invalid configuration assignment on line ${i + 1}`);
    let value = match[2];
    try {
      if (value.startsWith('"')) {
        const quoted = value.match(/^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/);
        if (!quoted) throw new Error();
        value = JSON.parse(quoted[1]);
      }
      else if (value.startsWith("'")) {
        const quoted = value.match(/^'([^']*)'(?:\s+#.*)?$/);
        if (!quoted) throw new Error();
        value = quoted[1];
      } else value = value.replace(/\s+#.*$/, '');
      if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error();
    } catch { throw new Error(`Invalid configuration value on line ${i + 1}`); }
    values[match[1]] = value;
  }
  return values;
}

export function serializeEnv(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new Error('Invalid configuration key or value');
    return `${key}=${JSON.stringify(value)}`;
  }).join('\n') + '\n';
}

export function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw new Error(`Cannot read configuration file (${error.code || 'I/O error'})`); }
  for (const [key, value] of Object.entries(parseEnvText(text))) if (env[key] === undefined) env[key] = value;
  return true;
}

export function writeEnvFile(file, values) {
  const content = serializeEnv(values);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Configuration path must be a regular file');
    fs.chmodSync(file, 0o600);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readControllerConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  const host = env.CACHE_HOST || '127.0.0.1';
  if (!/^[a-zA-Z0-9_.:%-]+$/.test(host)) throw new Error('CACHE_HOST contains invalid characters');
  return {
    port: integer('CACHE_PORT', 4000, 1, 65535), host,
    requestHost: host === '::' || host === '::1' ? '::1' : ['0.0.0.0', 'localhost'].includes(host) ? '127.0.0.1' : host,
    token: env.CACHE_AUTH_TOKEN || '',
    timeout: integer('CACHE_REQUEST_TIMEOUT_MS', 2000, 1, 120000),
  };
}

export function requestLocal(route, config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = http.get({ host: config.requestHost, port: config.port, path: route,
      headers: config.token ? { 'x-cache-auth': config.token } : {} }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(new Error('Local response exceeded 1 MiB'));
        else chunks.push(chunk);
      });
      res.on('end', () => settle(null, { status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', error => settle(error));
      res.on('aborted', () => settle(new Error('Local response aborted')));
    });
    req.on('error', error => settle(error));
    timer = setTimeout(() => { req.destroy(new Error('Local request timed out')); }, config.timeout);
  });
}

export function readProxyPid(text) {
  const value = text.trim();
  const pid = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid proxy PID file; refusing to signal a process');
  return pid;
}

export function processCommand(pid) {
  pid = readProxyPid(String(pid));
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim();
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim()) return '';
    throw new Error('Cannot verify proxy process identity; refusing to signal');
  }
}

export function isProxyCommand(command, proxy) {
  return [process.execPath, path.basename(process.execPath), 'node', 'nodejs'].some(node =>
    [`${node} ${proxy}`, `"${node}" "${proxy}"`, `"${node}" ${proxy}`, `${node} "${proxy}"`].includes(command.trim()));
}

export function stopProxy(pidfile, proxy, { readCommand = processCommand, signal = pid => process.kill(pid) } = {}) {
  let text;
  try { text = fs.readFileSync(pidfile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const pid = readProxyPid(text);
  const command = readCommand(pid);
  if (command && !isProxyCommand(command, proxy)) throw new Error('PID belongs to another process; refusing to signal');
  if (command) signal(pid);
  fs.rmSync(pidfile, { force: true });
  return Boolean(command);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'env-read' || !process.argv[3]) throw new Error('Usage: controller.mjs env-read <file>');
    const values = parseEnvText(fs.readFileSync(process.argv[3], 'utf8'));
    for (const [key, value] of Object.entries(values)) process.stdout.write(`${key}\0${value}\0`);
  } catch (error) { console.error(error.code ? `Configuration read failed (${error.code})` : error.message); process.exitCode = 1; }
}
