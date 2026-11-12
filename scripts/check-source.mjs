// Syntax checks only. Never execute a runtime entrypoint or load credentials.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of [...new Set(files)].sort()) {
  const full = path.resolve(file);
  if (file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', full], { stdio: 'inherit' });
  if (file.endsWith('.sh')) execFileSync('bash', ['-n', full], { stdio: 'inherit' });
  if (file.endsWith('.py')) execFileSync('python3', ['-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_bytes(), str(p), "exec")', full], { stdio: 'inherit' });
}
console.log('Source syntax checks passed.');
