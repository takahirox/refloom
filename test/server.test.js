import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { createRefloomServer } from '../server.mjs';
import { createWorkspace } from '../src/domain.js';
import { PersistenceError, RevisionConflictError } from '../src/persistence-errors.js';

let server;
let origin;
let repository;

class MemoryRepository {
  constructor() {
    this.calls = [];
    this.revision = 0;
    this.workspace = createWorkspace();
  }
  async initialize() { this.calls.push('initialize'); return { ready: true, revision: this.revision }; }
  async readiness() { this.calls.push('readiness'); return true; }
  async load() { this.calls.push('load'); return { revision: this.revision, workspace: structuredClone(this.workspace) }; }
  async commit(expected, workspace) {
    this.calls.push('commit');
    if (expected !== this.revision) throw new RevisionConflictError(expected, this.revision);
    this.workspace = structuredClone(workspace);
    this.revision += 1;
    return this.load();
  }
  async mediaInfo() { throw new PersistenceError('missing', { code: 'PERSISTENCE_NOT_FOUND' }); }
  async exportBackup() { this.calls.push('exportBackup'); return '{}'; }
  async importBackup() { this.calls.push('importBackup'); return this.load(); }
  async cleanupMedia() { this.calls.push('cleanupMedia'); return { deleted: 0 }; }
  async close() { this.calls.push('close'); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function listen(instance) {
  instance.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    instance.once('listening', resolve);
    instance.once('error', reject);
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

before(async () => {
  repository = new MemoryRepository();
  server = createRefloomServer({ store: repository });
  origin = await listen(server);
  await server.initialization;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await server.repositoryClosed;
});

function get(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const operation = request(`${origin}${pathname}`, { method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    operation.once('error', reject);
    operation.end();
  });
}

test('serves the application root with HTML cache policy', async () => {
  const response = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.equal(response.headers['content-length'], String(response.body.length));
  assert.equal(response.headers['cache-control'], 'no-cache');
  assert.match(response.body.toString(), /Refloom/);
});

test('serves public CSS with a short revalidation policy', async () => {
  const response = await get('/styles.css');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/css/);
  assert.equal(response.headers['content-length'], String(response.body.length));
  assert.equal(response.headers['cache-control'], 'public, max-age=300, must-revalidate');
});

test('serves source modules with the JavaScript content type', async () => {
  const response = await get('/src/domain.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/javascript/);
  assert.match(response.body.toString(), /createWorkspace/);
});

test('HEAD returns GET metadata without a response body', async () => {
  const getResponse = await get('/styles.css');
  const headResponse = await get('/styles.css', 'HEAD');
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers['content-type'], getResponse.headers['content-type']);
  assert.equal(headResponse.headers['content-length'], getResponse.headers['content-length']);
  assert.equal(headResponse.body.length, 0);
});

test('missing and traversal paths return generic 404 responses', async () => {
  for (const pathname of ['/missing.txt', '/..%2fpackage.json', '/src/..%2fserver.mjs']) {
    const response = await get(pathname);
    assert.equal(response.status, 404);
    assert.equal(response.body.toString(), 'Not found');
    assert.doesNotMatch(response.body.toString(), /private|server\.mjs|ENOENT/);
  }
});

function call(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const operation = request(`${origin}${pathname}`, { method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    operation.once('error', reject);
    operation.end(body);
  });
}

test('workspace API uses one initialized repository and rejects stale revisions', async () => {
  const initial = await call('/api/workspace');
  assert.equal(initial.status, 200);
  const state = JSON.parse(initial.body);
  const committed = await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, workspace: state.workspace, binaries: [] }) });
  assert.equal(committed.status, 200);
  const stale = await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, workspace: state.workspace, binaries: [] }) });
  assert.equal(stale.status, 409);
  assert.equal(repository.calls.filter(call => call === 'initialize').length, 1);
});

test('API rejects hostile host and origin values', async () => {
  assert.equal((await call('/api/workspace', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call('/api/workspace', { headers: { Origin: 'https://evil.example' } })).status, 403);
});

test('API rejects non-JSON mutation requests and unsupported methods', async () => {
  assert.equal((await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const unsupported = await call('/api/workspace', { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.allow, 'GET, PUT');
});

test('API rejects declared oversized bodies without reading them', async () => {
  const response = await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': String(41 * 1024 * 1024) } });
  assert.equal(response.status, 413);
});

test('capture API passes only a bounded reference request to the injected service', async t => {
  const calls = [];
  const captureRepository = new MemoryRepository();
  const injected = createRefloomServer({ store: captureRepository, captureReference: async (...args) => {
    calls.push(args);
    return { status: 'complete', captured: [{ assetId: 'asset-1', targetId: 'target-1', momentId: 'moment-1', mediaId: 'private' }], summary: { private: true } };
  } });
  const captureOrigin = await listen(injected);
  await injected.initialization;
  t.after(() => injected.close());
  const response = await fetch(`${captureOrigin}/api/captures`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ referenceId: 'reference-1', settings: { width: 800, height: 600, checkpoints: 2 } })
  });
  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], captureRepository);
  assert.deepEqual(calls[0][2], { width: 800, height: 600, checkpoints: 2, readinessMs: 1000, settleMs: 500, maxRedirects: 10 });
  assert.deepEqual(await response.json(), { status: 'complete', captured: [{ assetId: 'asset-1', targetId: 'target-1', momentId: 'moment-1' }] });
});

test('capture API rejects executable, proxy, dependency, URL, and unknown settings', async () => {
  for (const value of [
    { referenceId: 'r', chromePath: '/tmp/chrome', settings: {} },
    { referenceId: 'r', url: 'https://example.com', settings: {} },
    { referenceId: 'r', settings: { proxy: 'http://localhost:9' } },
    { referenceId: 'r', settings: { dependencies: {} } },
    { referenceId: 'r', settings: { width: 319 } }
  ]) {
    const response = await call('/api/captures', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
  }
  const oversized = await call('/api/captures', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(17 * 1024) }
  });
  assert.equal(oversized.status, 413);
});

test('unsupported methods return 405 and advertise supported methods', async () => {
  const response = await get('/', 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
  assert.equal(response.body.toString(), 'Method not allowed');
});

test('responses include the complete security header policy', async () => {
  for (const pathname of ['/', '/missing.txt']) {
    const response = await get(pathname);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['permissions-policy'], /camera=\(\)/);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['x-frame-options'], 'DENY');
  }
});
test('health is live without calling the repository', async t => {
  const pending = deferred();
  const store = new MemoryRepository();
  store.initialize = () => pending.promise;
  const instance = createRefloomServer({ store });
  const localOrigin = await listen(instance);
  t.after(() => instance.close());
  const response = await fetch(`${localOrigin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(store.calls, []);
  pending.resolve({ ready: true });
  await instance.initialization;
});

test('readiness and API requests follow initialization state', async t => {
  const pending = deferred();
  const store = new MemoryRepository();
  store.initialize = () => { store.calls.push('initialize'); return pending.promise; };
  const instance = createRefloomServer({ store });
  const localOrigin = await listen(instance);
  t.after(() => instance.close());
  assert.equal((await fetch(`${localOrigin}/readyz`)).status, 503);
  assert.equal((await fetch(`${localOrigin}/api/workspace`)).status, 503);
  pending.resolve({ ready: true });
  await instance.initialization;
  assert.equal((await fetch(`${localOrigin}/readyz`)).status, 200);
  assert.equal(store.calls.filter(call => call === 'initialize').length, 1);
});

test('failed initialization remains generically unavailable while assets stay available', async t => {
  const store = new MemoryRepository();
  store.initialize = async () => { throw new Error('postgres://user:secret@private/db'); };
  const instance = createRefloomServer({ store });
  const localOrigin = await listen(instance);
  t.after(() => instance.close());
  await assert.rejects(instance.initialization);
  const ready = await fetch(`${localOrigin}/readyz`);
  const api = await fetch(`${localOrigin}/api/workspace`);
  assert.equal(ready.status, 503);
  assert.equal(api.status, 503);
  assert.doesNotMatch(await api.text(), /secret|private|postgres/i);
  assert.equal((await fetch(`${localOrigin}/`)).status, 200);
});

test('cleanup starts after initialization, never overlaps, and close runs once', async () => {
  const scheduled = [];
  const cleared = [];
  const scheduler = {
    setInterval(callback, delay) { scheduled.push({ callback, delay }); return 7; },
    clearInterval(id) { cleared.push(id); }
  };
  const cleanup = deferred();
  const store = new MemoryRepository();
  let active = 0;
  let maximum = 0;
  store.cleanupMedia = async () => {
    store.calls.push('cleanupMedia');
    active += 1;
    maximum = Math.max(maximum, active);
    if (store.calls.filter(call => call === 'cleanupMedia').length > 1) await cleanup.promise;
    active -= 1;
  };
  const instance = createRefloomServer({ store, cleanupIntervalMs: 50, scheduler });
  await listen(instance);
  await instance.initialization;
  assert.equal(store.calls.filter(call => call === 'cleanupMedia').length, 1);
  assert.equal(scheduled[0].delay, 50);
  const first = scheduled[0].callback();
  await Promise.resolve();
  await scheduled[0].callback();
  assert.equal(store.calls.filter(call => call === 'cleanupMedia').length, 2);
  cleanup.resolve();
  await first;
  assert.equal(maximum, 1);
  await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  await instance.repositoryClosed;
  instance.emit('close');
  assert.deepEqual(cleared, [7]);
  assert.equal(store.calls.filter(call => call === 'close').length, 1);
});

test('stable conflict and unexpected failures use safe HTTP errors', async t => {
  const store = new MemoryRepository();
  store.load = async () => { throw new Error('credential=private-secret'); };
  const instance = createRefloomServer({ store });
  const localOrigin = await listen(instance);
  await instance.initialization;
  t.after(() => instance.close());
  const failure = await fetch(`${localOrigin}/api/workspace`);
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: 'The local operation failed', code: 'INTERNAL_ERROR' });
});
