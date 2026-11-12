import fs from 'node:fs';
import path from 'node:path';
import { buildOutputs } from './generate-doc-indexes.mjs';
for (const [file, expected] of Object.entries(buildOutputs())) {
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== expected) throw new Error(`${file} is stale; run npm run docs:generate`);
}
const index = JSON.parse(fs.readFileSync('docs/high_signal_file_index.json', 'utf8'));
const markdown = [...new Set(['README.md', 'CLAUDE.md', 'AGENTS.md', 'GEMINI.md', ...index.map(e => e.path).filter(f => f.endsWith('.md'))])];
let count = 0;
for (const file of markdown) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!resolved.startsWith(process.cwd() + path.sep) || !fs.existsSync(resolved)) throw new Error(`Dead local link: ${file} -> ${target}`);
    count++;
  }
}
console.log(`Documentation indexes and ${count} local links checked.`);
