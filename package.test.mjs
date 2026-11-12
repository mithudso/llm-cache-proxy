import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('published modules include every relative import and exclude private workflow bodies', { skip: process.platform === 'win32' }, () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const file of files) {
    assert.ok(!/(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|memory\.md|prompts\.md|\.env(?:\..*)?)$/.test(file), file);
    assert.ok(!file.startsWith('docs/archive/'), file);
    if (!file.endsWith('.mjs')) continue;
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(files.has(imported), `${file} imports missing package file ${imported}`);
    }
  }
});
