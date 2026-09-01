import { access, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'Dockerfile',
  'compose.yaml',
  'compose.integration.yaml',
  'migrations/0002_workspace_capture_settings.sql',
  'config/README.md',
  'config/chromium-seccomp.json',
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
  'src/create-persistence-repository.js',
  'src/persistence-config.js',
  'src/persistence-errors.js',
  'src/persistence-repository.js',
  'src/postgres-migrations.js',
  'src/postgres-workspace-mapper.js',
  'src/postgres-workspace-repository.js',
  'src/s3-media-store.js',
  'src/storage.js',
  'src/ui-format.js',
  'src/capture-url.js',
  'src/capture-proxy.js',
  'src/chrome-capture.js',
  'src/capture-request.js',
  'src/capture-scheduler.js',
  'src/website-capture-service.js',
  'test/capture-url.test.js',
  'test/app-contract.test.js',
  'test/capture-proxy.test.js',
  'test/chrome-capture.test.js',
  'test/capture-scheduler.test.js',
  'test/website-capture-service.test.js',
  'test/integration/persistence.integration.test.js',
  'test/domain.test.js',
  'test/storage.test.js',
  'test/create-persistence-repository.test.js',
  'test/persistence-config.test.js',
  'test/postgres-migrations.test.js',
  'test/postgres-workspace-mapper.test.js',
  'test/postgres-workspace-repository.test.js',
  'test/s3-media-store.test.js',
  'test/ui-format.test.js',
  'test/server.test.js',
  'test/mcp-server.test.js',
  'scripts/check.mjs',
  'scripts/check-browser.mjs',
  'scripts/init-bucket.mjs',
  'scripts/test-integration.mjs'
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

const persistenceSources = await Promise.all([
  'server.mjs', 'mcp-server.mjs', 'src', 'test'
].map(async entry => {
  const absolute = path.join(root, entry);
  const files = entry === 'src' || entry === 'test' ? await modules(absolute) : [absolute];
  return Promise.all(files.map(file => readFile(file, 'utf8')));
}));
const removedPersistence = [
  ['IndexedDB authority', /\b(?:indexedDB|IDBDatabase)\b/],
  ['file workspace store', /\bFileWorkspaceStore\b|file-workspace-store/],
  ['local data directory', /\bREFLOOM_DATA_DIR\b|\bdataDirectory\b/]
];
const persistenceText = persistenceSources.flat(2).join('\n');
for (const [label, pattern] of removedPersistence) if (pattern.test(persistenceText)) {
  console.error(`Removed persistence path found: ${label}`);
  process.exitCode = 1;
}

if (!process.exitCode) console.log('Repository check passed.');
