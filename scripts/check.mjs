import { access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = ['package.json', 'docs/PRODUCT_SLICE.md', 'src/domain.js', 'test/domain.test.js', 'scripts/check.mjs'];

for (const file of required) {
  try {
    await access(path.join(root, file));
  } catch {
    console.error(`Missing required file: ${file}`);
    process.exitCode = 1;
  }
}

async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await modules(absolute));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) found.push(absolute);
  }
  return found;
}

for (const file of await modules(root)) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
  if (result !== 0) process.exitCode = 1;
}

if (!process.exitCode) console.log('Repository check passed.');
