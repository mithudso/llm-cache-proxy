import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const explorer = fileURLToPath(new URL('./cache-explorer.mjs', import.meta.url));
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-explorer-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const entries = path.join(home, '.llm-cache-a', 'entries');
  fs.mkdirSync(entries, { recursive: true });
  const key = 'a'.repeat(64);
  fs.writeFileSync(path.join(entries, key + '.bin'), '\x1b]52;c;private\x07');
  fs.writeFileSync(path.join(entries, key + '.json'), JSON.stringify({ ts: Date.now(), model: '\x1b[31munsafe' }));
  const run = (...args) => spawnSync(process.execPath, [explorer, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 5000 });
  return { home, entries, key, run };
}

test('empty invalidation prefix cannot remove the whole cache', t => {
  const f = fixture(t);
  const result = f.run('--invalidate', '');
  assert.equal(result.status, 1);
  assert.ok(fs.existsSync(path.join(f.entries, f.key + '.bin')));
});

test('untrusted metadata and payload cannot emit terminal control sequences', t => {
  const f = fixture(t);
  for (const args of [['--list'], ['--view', f.key]]) {
    const result = f.run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('\x1b'));
    assert.ok(!result.stdout.includes('\x07'));
    assert.match(result.stdout, /\\x1b/);
  }
});

test('import has no CLI side effects and invalidate rejects traversal and missing entries', t => {
  const f = fixture(t);
  const sentinel = path.join(f.home, '.llm-cache-a', 'sentinel.bin');
  fs.writeFileSync(sentinel, 'keep');
  const script = `const m=await import(${JSON.stringify(new URL('./cache-explorer.mjs', import.meta.url).href)}); const a=await import('node:assert/strict'); a.default.throws(()=>m.invalidate('../sentinel'), /invalid cache key/); a.default.equal(m.invalidate('b'.repeat(64)),false); console.log('imported');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: f.home }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'imported\n');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('malformed metadata is tolerated and explicit invalidation deletes its pair', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.entries, f.key + '.json'), 'null');
  const listed = f.run('--json');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 1);
  assert.equal(f.run('--invalidate', f.key).status, 0);
  assert.deepEqual(fs.readdirSync(f.entries), []);
});
