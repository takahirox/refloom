import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createRefloomServer } from '../server.mjs';

let server;
let origin;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'refloom-server-'));
  server = createRefloomServer({ dataDirectory });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(dataDirectory, { recursive: true, force: true });
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

test('workspace API initializes and rejects stale revisions', async () => {
  const initial = await call('/api/workspace');
  assert.equal(initial.status, 200);
  const state = JSON.parse(initial.body);
  const committed = await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, workspace: state.workspace, binaries: [] }) });
  assert.equal(committed.status, 200);
  const stale = await call('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: state.revision, workspace: state.workspace, binaries: [] }) });
  assert.equal(stale.status, 409);
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
