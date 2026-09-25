// start() refuses to bind a non-loopback host unless an auth token is configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('refuses to bind a non-loopback host without CACHE_AUTH_TOKEN', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-'));
  fs.mkdirSync(path.join(home, '.llm-cache-a'), { recursive: true });
  process.env.HOME = home;
  process.env.ANTHROPIC_API_KEY_REAL = 'k';
  process.env.CACHE_QUIET = '1';
  process.env.CACHE_HOST = '0.0.0.0';
  delete process.env.CACHE_AUTH_TOKEN;
  process.env.CACHE_UPSTREAM_PROTO = 'http';
  process.env.CACHE_UPSTREAM_HOST = '127.0.0.1';
  process.env.CACHE_UPSTREAM_PORT = '1';

  const mod = await import('./proxy-a.mjs');
  assert.throws(() => mod.start(0), /CACHE_AUTH_TOKEN/);   // refused before listening
  fs.rmSync(home, { recursive: true, force: true });
});
