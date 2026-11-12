import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

function fixture(repoName = 'repo') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-controller-'));
  const repo = path.join(root, repoName);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  for (const dir of [repo, home, bin, path.join(home, '.llm-cache-a')]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(new URL('./cachectl-a.sh', import.meta.url), path.join(repo, 'cachectl-a.sh'));
  if (fs.existsSync(new URL('./lib/controller.mjs', import.meta.url))) {
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.copyFileSync(new URL('./lib/controller.mjs', import.meta.url), path.join(repo, 'lib/controller.mjs'));
    fs.copyFileSync(new URL('./lib/proxy-validation.mjs', import.meta.url), path.join(repo, 'lib/proxy-validation.mjs'));
  }
  const stub = (name, body) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  stub('curl', 'printf 000; exit 7');
  stub('launchctl', 'exit 0');
  stub('pkill', 'echo blanket-kill >&2; exit 1');
  stub('lsof', 'exit 1');
  stub('uname', 'echo Darwin');
  const env = { ...process.env, HOME: home, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, ANTHROPIC_API_KEY_REAL: 'sk-ant-fixture' };
  for (const key of Object.keys(env)) if (key.startsWith('CACHE_')) delete env[key];
  const run = (args, options = {}) => spawnSync('bash', ['cachectl-a.sh', ...args], { cwd: repo, env, encoding: 'utf8', timeout: 5000, ...options });
  return { root, repo, home, env, stub, run, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('offline validation succeeds without claiming an HTTP failure', () => {
  const f = fixture();
  try {
    const result = f.run(['validate']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /proxy not running/);
    assert.doesNotMatch(result.stdout, /000000/);
  } finally { f.close(); }
});

test('invalid normalization reports a diagnostic and final validation summary', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.llm-cache-a', 'normalize.json'), '{invalid');
    const result = f.run(['validate']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /normalize\.json —/);
    assert.match(result.stdout, /Result: 1 error/);
  } finally { f.close(); }
});

test('setup stores literal answers without executing substitutions on the next invocation', () => {
  const f = fixture();
  try {
    const marker = path.join(f.root, 'executed');
    const key = `$(touch ${marker})`;
    const result = f.run(['setup'], { input: `${key}\n\n\n\n\n` });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.statSync(path.join(f.repo, '.env')).mode & 0o777, 0o600);
    f.run(['--help']);
    assert.equal(fs.existsSync(marker), false);
  } finally { f.close(); }
});

test('stop preserves an unrelated process referenced by a stale pidfile', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    f.stub('pkill', 'touch "$HOME/blanket-kill"; exit 0');
    fs.writeFileSync(path.join(f.home, '.llm-cache-a', 'proxy.pid'), String(child.pid));
    const result = f.run(['stop']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    assert.equal(fs.existsSync(path.join(f.home, 'blanket-kill')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
    f.close();
  }
});

test('relative paths from the parent directory resolve the repository once', () => {
  const f = fixture();
  try {
    const result = spawnSync('bash', ['repo/cachectl-a.sh', '--help'], { cwd: f.root, env: f.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { f.close(); }
});

test('launchd installation creates valid XML with argument paths escaped', () => {
  const f = fixture('repo & spaces');
  try {
    const result = f.run(['install']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const file = path.join(f.home, 'Library', 'LaunchAgents', 'com.llm-cache-proxy.plist');
    const parsed = spawnSync('python3', ['-c', 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); assert p["ProgramArguments"][0] == "/bin/bash"; assert p["ProgramArguments"][1] == sys.argv[2]', file, path.join(fs.realpathSync(f.repo), 'cachectl-a.sh')], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally { f.close(); }
});

test('status counts timestamped proxy ERROR records', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.llm-cache-a', 'proxy.log'), '2026-11-12T00:00:00Z  ERROR fixture\n2026-11-12T00:00:01Z  MISS fixture\n');
    const result = f.run(['status']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /errors this run: 1/);
  } finally { f.close(); }
});

test('validate rejects a non-loopback bind without an access token', () => {
  const f = fixture();
  try {
    f.env.CACHE_HOST = '0.0.0.0';
    const result = f.run(['validate']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /CACHE_AUTH_TOKEN — required/);
  } finally { f.close(); }
});

test('validate reports invalid price data without exiting before the summary', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.home, '.llm-cache-a', 'prices.json'), '{"haiku":[-1,2]}');
    const result = f.run(['validate']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✗ prices\.json —/);
    assert.match(result.stdout, /Result: 1 error/);
  } finally { f.close(); }
});

test('setup rotates a key and preserves unrelated optional settings', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, '.env'), 'ANTHROPIC_API_KEY_REAL=sk-ant-old\nCACHE_LOG_LEVEL=debug\n');
    const result = f.run(['setup'], { input: 'sk-ant-new\n\n\n\n\n' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const text = fs.readFileSync(path.join(f.repo, '.env'), 'utf8');
    assert.match(text, /ANTHROPIC_API_KEY_REAL="sk-ant-new"/);
    assert.match(text, /CACHE_LOG_LEVEL="debug"/);
  } finally { f.close(); }
});

test('on starts an owned process and stop terminates that process only', async () => {
  const f = fixture();
  let pid;
  try {
    f.stub('curl', 'printf 200');
    fs.writeFileSync(path.join(f.repo, 'proxy-a.mjs'), 'setInterval(() => {}, 1000);\n');
    const result = f.run(['on']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /READY/);
    pid = Number(fs.readFileSync(path.join(f.home, '.llm-cache-a', 'proxy.pid'), 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0));
    const stopped = f.run(['stop']);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A reparented process can briefly remain a zombie, so verify identity through ps.
    const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    assert.doesNotMatch(ps.stdout, /proxy-a\.mjs/);
    pid = undefined;
  } finally {
    if (pid) { try { process.kill(pid); } catch {} }
    f.close();
  }
});

test('stop refuses a process that only mentions the proxy path as an argument', async () => {
  const f = fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(fs.realpathSync(f.repo), 'proxy-a.mjs')], { stdio: 'ignore' });
  try {
    await new Promise(resolve => child.once('spawn', resolve));
    fs.writeFileSync(path.join(f.home, '.llm-cache-a', 'proxy.pid'), String(child.pid));
    const result = f.run(['stop']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(child.signalCode, null);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    f.close();
  }
});

test('stop preserves a boot service installed by a different checkout', () => {
  const f = fixture();
  try {
    const dir = path.join(f.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'com.llm-cache-proxy.plist'), '<plist><string>/another-checkout/cachectl-a.sh</string></plist>');
    f.stub('launchctl', 'touch "$HOME/unloaded"');
    const result = f.run(['stop']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(f.home, 'unloaded')), false);
  } finally { f.close(); }
});

test('on lets an installed launchd service own the single proxy process', async () => {
  const f = fixture();
  const started = path.join(f.home, 'starts');
  try {
    const canonicalRepo = fs.realpathSync(f.repo);
    const dir = path.join(f.home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'com.llm-cache-proxy.plist'), `<plist><string>${canonicalRepo}/cachectl-a.sh</string></plist>`);
    fs.writeFileSync(path.join(f.repo, 'proxy-a.mjs'), 'import fs from "node:fs"; fs.appendFileSync(process.env.HOME + "/starts", process.pid + "\\n"); setInterval(() => {}, 1000);\n');
    f.env.LCP_TEST_NODE = process.execPath;
    f.env.LCP_TEST_PROXY = path.join(canonicalRepo, 'proxy-a.mjs');
    f.stub('curl', 'printf 200');
    f.stub('launchctl', 'if [ "$1" = load ]; then "$LCP_TEST_NODE" "$LCP_TEST_PROXY" >/dev/null 2>&1 & echo $! > "$HOME/.llm-cache-a/proxy.pid"; fi; exit 0');
    const result = f.run(['on']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(started, 'utf8').trim().split('\n').length, 1);
    const stopped = f.run(['stop']);
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  } finally {
    if (fs.existsSync(started)) for (const text of fs.readFileSync(started, 'utf8').trim().split('\n')) {
      const pid = Number(text);
      const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      if (ps.stdout.includes(path.join(fs.realpathSync(f.repo), 'proxy-a.mjs'))) { try { process.kill(pid); } catch {} }
    }
    f.close();
  }
});

for (const [name, value] of [['CACHE_MAX_REQUEST_BYTES', '0'], ['CACHE_TTL_SEC', '-2']]) {
  test(`validate rejects invalid runtime limits: ${name}`, () => {
    const f = fixture();
    try {
      f.env[name] = value;
      const result = f.run(['validate']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`invalid ${name}`));
      assert.match(result.stdout, /Result: 1 error/);
      assert.doesNotMatch(result.stdout, /all checks passed/);
    } finally { f.close(); }
  });
}

test('monitor renders terminal control characters as literal escapes in all event fields', () => {
  const f = fixture();
  try {
    const events = [
      { t: 0, seq: '\x07SEQ', type: 'HIT\x9b0m', model: '\x1b]2;title\x07model', in: 1, out: '\x1f2', ms: '7\x1b[31m', snippet: '\x1b[31mred\n\t\x9b0m' },
      { t: 0, type: 'ERROR', model: 'test', err: '\x1b[2Jfailure\r\n\x7f' },
    ];
    const sse = path.join(f.root, 'events.sse');
    fs.writeFileSync(sse, events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    f.env.LCP_SSE_FIXTURE = sse;
    f.stub('curl', 'cat "$LCP_SSE_FIXTURE"');
    const result = f.run(['monitor']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    for (const escaped of ['\\x07SEQ', 'HIT\\x9b0m', '\\x1b]2;title\\x07model', '\\x1f2', '7\\x1b[31m', '\\x1b[31mred\\x0a\\x09\\x9b0m', '\\x1b[2Jfailure\\x0d\\x0a\\x7f']) {
      assert.ok(result.stdout.includes(escaped), `missing literal escape ${escaped}: ${JSON.stringify(result.stdout)}`);
    }
  } finally { f.close(); }
});
