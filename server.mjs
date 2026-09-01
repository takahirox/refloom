import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPersistenceRepository } from './src/create-persistence-repository.js';
import { PersistenceError } from './src/persistence-errors.js';
import { normalizeCaptureRequest, publicCaptureResult } from './src/capture-request.js';
import { captureReference as defaultCaptureReference } from './src/website-capture-service.js';

const MAX_BODY = 40 * 1024 * 1024;

const types = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8']]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};

function send(response, status, body, headers = {}) {
  const contents = Buffer.from(body);
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': contents.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(contents);
}

function json(response, status, value) { send(response, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' }); }

async function body(request, maximum = MAX_BODY) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new PersistenceError('Mutation requests require application/json', { code: 'JSON_REQUIRED' });
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) throw new PersistenceError('Request body is too large', { code: 'BODY_TOO_LARGE' });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new PersistenceError('Request body is too large', { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PersistenceError('Request body is not valid JSON', { code: 'INVALID_JSON' }); }
}

function trustedRequest(request) {
  const host = request.headers.host || '';
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const value = new URL(origin); return /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(value.hostname) && value.host === host; }
  catch { return false; }
}

async function api(request, response, pathname, store, captureReference) {
  if (pathname === '/api/workspace' && request.method === 'GET') return json(response, 200, await store.load());
  if (pathname === '/api/workspace' && request.method === 'PUT') {
    const value = await body(request);
    return json(response, 200, await store.commit(value.revision, value.workspace, value.binaries));
  }
  if (pathname === '/api/backup' && request.method === 'GET') return send(response, 200, await store.exportBackup(), { 'Content-Type': 'application/json; charset=utf-8' });
  if (pathname === '/api/backup' && request.method === 'PUT') {
    const value = await body(request);
    return json(response, 200, await store.importBackup(value.revision, JSON.stringify(value.backup)));
  }
  if (pathname === '/api/captures' && request.method === 'POST') {
    const requestValue = normalizeCaptureRequest(await body(request, 16 * 1024));
    const result = await captureReference(store, requestValue.referenceId, requestValue.settings);
    const value = publicCaptureResult(result);
    if (result.status === 'complete') return json(response, 201, value);
    if (result.status === 'partial') return json(response, 207, value);
    if (result.error === 'CAPTURE_BUSY') return json(response, 409, { status: 'busy', code: 'CAPTURE_BUSY' });
    if (result.error === 'INVALID_REFERENCE' || result.error === 'INVALID_SETTINGS') {
      return json(response, 400, { status: 'invalid', code: result.error });
    }
    return json(response, 502, { status: 'failed', code: 'CAPTURE_FAILED' });
  }
  if (pathname.startsWith('/api/media/') && request.method === 'GET') {
    const media = await store.mediaInfo(decodeURIComponent(pathname.slice('/api/media/'.length)));
    return send(response, 200, media.contents, { 'Content-Type': media.mediaType });
  }
  const allow = pathname === '/api/captures' ? 'POST' : pathname === '/api/workspace' || pathname === '/api/backup' ? 'GET, PUT' : 'GET';
  if (pathname.startsWith('/api/')) return send(response, 405, 'Method not allowed', { Allow: allow });
  return false;
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveAsset(repositoryRoot, pathname) {
  const publicRoot = path.join(repositoryRoot, 'public');
  if (pathname === '/') return { filename: path.join(publicRoot, 'index.html'), html: true };

  const source = pathname.startsWith('/src/');
  const allowedRoot = source ? path.join(repositoryRoot, 'src') : publicRoot;
  const routePath = source ? pathname.slice('/src'.length) : pathname;
  const filename = path.resolve(allowedRoot, `.${routePath}`);
  if (!contained(allowedRoot, filename)) return null;
  return { filename, html: path.extname(filename) === '.html' };
}

async function openStream(filename) {
  const stream = createReadStream(filename);
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
  });
  return stream;
}

function apiFailure(error) {
  const statuses = {
    REVISION_CONFLICT: 409,
    PERSISTENCE_NOT_FOUND: 404,
    BODY_TOO_LARGE: 413,
    JSON_REQUIRED: 415,
    INVALID_JSON: 400
  };
  const status = statuses[error?.code] ?? (error instanceof TypeError ? 400 : 500);
  const headers = error?.code === 'BODY_TOO_LARGE' ? { Connection: 'close' } : {};
  const value = status < 500
    ? { error: error.message, code: error.code ?? 'INVALID_REQUEST' }
    : { error: 'The local operation failed', code: 'INTERNAL_ERROR' };
  return { status, headers, value };
}

export function createRefloomServer(options = {}) {
  const repositoryRoot = path.resolve(options.root ?? import.meta.dirname);
  const persistence = options.store === undefined
    ? createPersistenceRepository({ env: options.env ?? process.env })
    : { repository: options.store, cleanupIntervalMs: options.cleanupIntervalMs ?? 3_600_000 };
  const store = persistence.repository;
  const captureReference = options.captureReference ?? defaultCaptureReference;
  const scheduler = options.scheduler ?? globalThis;
  let initializationState = 'initializing';
  let cleanupTimer;
  let cleanupRunning = false;
  let repositoryClose;

  const cleanup = async () => {
    if (cleanupRunning || initializationState !== 'ready') return;
    cleanupRunning = true;
    try { await store.cleanupMedia(); }
    catch { /* Cleanup is best effort and does not affect readiness. */ }
    finally { cleanupRunning = false; }
  };

  const initialization = Promise.resolve().then(() => store.initialize()).then(async value => {
    initializationState = 'ready';
    await cleanup();
    cleanupTimer = scheduler.setInterval(cleanup, persistence.cleanupIntervalMs);
    return value;
  }, error => {
    initializationState = 'failed';
    throw error;
  });
  initialization.catch(() => {});

  const server = createServer(async (request, response) => {
    response.on('error', () => {});

    if (!trustedRequest(request)) { send(response, 403, 'Forbidden'); return; }

    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { send(response, 400, 'Bad request'); return; }

    if (url.pathname === '/healthz') {
      json(response, 200, { status: 'live' });
      return;
    }

    if (url.pathname === '/readyz') {
      if (initializationState !== 'ready') { json(response, 503, { error: 'The local service is unavailable', code: 'SERVICE_UNAVAILABLE' }); return; }
      try { await store.readiness(); json(response, 200, { status: 'ready' }); }
      catch { json(response, 503, { error: 'The local service is unavailable', code: 'SERVICE_UNAVAILABLE' }); }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (initializationState !== 'ready') {
        json(response, 503, { error: 'The local service is unavailable', code: 'SERVICE_UNAVAILABLE' });
        return;
      }
      try {
        await api(request, response, url.pathname, store, captureReference);
      } catch (error) {
        const failure = apiFailure(error);
        send(response, failure.status, JSON.stringify(failure.value), { 'Content-Type': 'application/json; charset=utf-8', ...failure.headers });
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    let asset;
    try {
      asset = resolveAsset(repositoryRoot, decodeURIComponent(url.pathname));
    } catch {
      asset = null;
    }

    if (!asset) {
      send(response, 404, 'Not found');
      return;
    }

    let info;
    try {
      info = await stat(asset.filename);
      if (!info.isFile()) throw new Error('Not a file');
    } catch {
      send(response, 404, 'Not found');
      return;
    }

    const headers = {
      ...securityHeaders,
      'Content-Type': types.get(path.extname(asset.filename)) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': asset.html ? 'no-cache' : 'public, max-age=300, must-revalidate'
    };

    if (request.method === 'HEAD') {
      response.writeHead(200, headers);
      response.end();
      return;
    }

    let stream;
    try {
      stream = await openStream(asset.filename);
    } catch {
      send(response, 404, 'Not found');
      return;
    }

    const stop = () => stream.destroy();
    request.once('aborted', stop);
    response.once('close', stop);
    stream.once('error', () => response.destroy());
    stream.once('close', () => {
      request.off('aborted', stop);
      response.off('close', stop);
    });
    response.writeHead(200, headers);
    stream.pipe(response);
  });

  Object.defineProperties(server, {
    initialization: { value: initialization },
    initializationState: { get: () => initializationState },
    repositoryClosed: { get: () => repositoryClose }
  });
  server.once('close', () => {
    if (cleanupTimer !== undefined) scheduler.clearInterval(cleanupTimer);
    repositoryClose ??= Promise.resolve().then(() => store.close());
    repositoryClose.catch(() => {});
  });
  return server;
}

export function startRefloomServer(options = {}) {
  const server = createRefloomServer(options);
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';

  server.once('error', () => {
    console.error('Refloom could not start');
    process.exitCode = 1;
  });
  server.initialization.catch(() => {
    console.error('Refloom persistence initialization failed');
    process.exitCode = 1;
    server.close();
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Refloom is available at http://${host}:${address.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) startRefloomServer();
