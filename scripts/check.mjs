import { access, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'docs/PRODUCT_SPEC.md',
  'docs/ARCHITECTURE.md',
  'docs/EXPORT_SCHEMA.md',
  'docs/PRIVACY_SECURITY.md',
  'docs/PRODUCT_SLICE.md',
  'docs/WEBSITE_CAPTURE.md',
  'docs/ROADMAP.md',
  'public/index.html',
  'public/styles.css',
  'server.mjs',
  'mcp-server.mjs',
  'src/app.js',
  'src/domain.js',
  'src/file-workspace-store.js',
  'src/storage.js',
  'src/ui-format.js',
  'src/capture-url.js',
  'src/capture-proxy.js',
  'src/chrome-capture.js',
  'src/capture-request.js',
  'src/website-capture-service.js',
  'test/capture-url.test.js',
  'test/capture-proxy.test.js',
  'test/chrome-capture.test.js',
  'test/website-capture-service.test.js',
  'test/domain.test.js',
  'test/storage.test.js',
  'test/file-workspace-store.test.js',
  'test/ui-format.test.js',
  'test/server.test.js',
  'test/mcp-server.test.js',
  'scripts/check.mjs'
];

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

const html = await import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'public/index.html'), 'utf8'));
const app = await import('node:fs/promises').then(fs => fs.readFile(path.join(root, 'src/app.js'), 'utf8'));
const forbidden = [
  ['innerHTML', /\.innerHTML\b/],
  ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
  ['eval', /\beval\s*\(/],
  ['inline event handlers', /\son[a-z]+\s*=/i]
];
for (const [label, pattern] of forbidden) if (pattern.test(`${html}\n${app}`)) {
  console.error(`Forbidden rendering mechanism found: ${label}`);
  process.exitCode = 1;
}

if (!process.exitCode) console.log('Repository check passed.');
