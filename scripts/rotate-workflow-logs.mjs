// Explicit maintenance only; never runs at session start or on every edit.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const files = ['memory.md', 'prompts.md'];
// Refuse the entire batch before writing any archive or truncating any log.
for (const file of files) {
  const swaps = [`.${file}.swp`, `.${file}.swo`, `${file}~`];
  if (swaps.some(p => fs.existsSync(p))) throw new Error(`Editor swap/backup is live for ${file}; close the editor first.`);
}
for (const file of files) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 200_000) continue;
  const text = fs.readFileSync(file, 'utf8');
  const sections = [...text.matchAll(/^## /gm)].map(m => m.index);
  if (sections.length < 2) throw new Error(`Cannot rotate ${file}: fewer than two version sections.`);
  const cut = sections[sections.length - 1];
  fs.mkdirSync('docs/archive', { recursive: true });
  const suffix = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const archive = path.join('docs/archive', `${suffix}-${file}`);
  const temporary = `${file}.${suffix}.tmp`;
  // Retain the complete original before publishing the shortened file atomically.
  fs.writeFileSync(archive, text, { flag: 'wx' });
  try {
    fs.writeFileSync(temporary, text.slice(0, sections[0]) + text.slice(cut), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  console.log(`Archived old sections in ${archive}`);
}
