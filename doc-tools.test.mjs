import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicPath } from './scripts/generate-doc-indexes.mjs';

test('retrieval excludes private workflow and secret basenames at every depth', () => {
  for (const file of ['AGENTS.md', 'docs/AGENTS.md', 'nested/CLAUDE.md', 'docs/prompts.md', 'x/memory.md', '.env', 'deep/.env.backup', '.remember/private.md', 'docs/archive/private.md', 'MCP-SERVERS-SYNC.md']) assert.equal(isPublicPath(file), false, file);
  for (const file of ['proxy-a.mjs', 'lib/controller.mjs', 'docs/TESTING.md', '.github/workflows/ci.yml']) assert.equal(isPublicPath(file), true, file);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractRoutes } from './scripts/generate-ops-registry-doc.mjs';

test('workflow rotation refuses any live swap before modifying either log', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcp-rotate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = '# Log\n\n## v1\n' + 'a'.repeat(210000) + '\n## v2\nlatest\n';
  fs.writeFileSync(path.join(dir, 'memory.md'), original);
  fs.writeFileSync(path.join(dir, '.prompts.md.swp'), 'editing');
  const script = fileURLToPath(new URL('./scripts/rotate-workflow-logs.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(dir, 'docs/archive')));
  fs.rmSync(path.join(dir, '.prompts.md.swp'));
  assert.equal(spawnSync(process.execPath, [script], { cwd: dir }).status, 0);
  const archives = fs.readdirSync(path.join(dir, 'docs/archive'));
  assert.equal(fs.readFileSync(path.join(dir, 'docs/archive', archives[0]), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), '# Log\n\n## v2\nlatest\n');
});

test('route inventory sees extra paths, changed methods and inverse POST guards', () => {
  const source = "req.method === 'GET' && pathname === '/health'; req.method !== 'POST' || pathname !== '/v1/messages'; req.method === 'DELETE' && pathname === '/extra';";
  assert.deepEqual(extractRoutes(source), ['DELETE /extra', 'GET /health', 'POST /v1/messages']);
});
