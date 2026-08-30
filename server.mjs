import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileWorkspaceStore, RevisionConflictError, StoreError } from './src/file-workspace-store.js';

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

async function body(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new StoreError('JSON_REQUIRED', 'Mutation requests require application/json');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new StoreError('BODY_TOO_LARGE', 'Request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new StoreError('BODY_TOO_LARGE', 'Request body is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new StoreError('INVALID_JSON', 'Request body is not valid JSON'); }
}

function trustedRequest(request) {
  const host = request.headers.host || '';
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { const value = new URL(origin); return /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(value.hostname) && value.host === host; }
  catch { return false; }
}

async function api(request, response, pathname, store) {
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
  if (pathname.startsWith('/api/media/') && request.method === 'GET') {
    const media = await store.mediaInfo(decodeURIComponent(pathname.slice('/api/media/'.length)));
    return send(response, 200, media.contents, { 'Content-Type': media.mediaType });
  }
  const allow = pathname === '/api/workspace' || pathname === '/api/backup' ? 'GET, PUT' : 'GET';
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

export function createRefloomServer(options = {}) {
  const repositoryRoot = path.resolve(options.root ?? import.meta.dirname);
  const store = options.store ?? new FileWorkspaceStore({ directory: options.dataDirectory ?? path.join(repositoryRoot, 'data') });
  let initialized;
  return createServer(async (request, response) => {
    response.on('error', () => {});

    if (!trustedRequest(request)) { send(response, 403, 'Forbidden'); return; }

    let url;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { send(response, 400, 'Bad request'); return; }

    if (url.pathname.startsWith('/api/')) {
      try {
        initialized ??= store.initialize();
        await initialized;
        await api(request, response, url.pathname, store);
      } catch (error) {
        const status = error instanceof RevisionConflictError ? 409 : error.code === 'BODY_TOO_LARGE' ? 413 : error.code === 'JSON_REQUIRED' ? 415 : error instanceof StoreError ? 400 : 500;
        const headers = error.code === 'BODY_TOO_LARGE' ? { Connection: 'close' } : {};
        send(response, status, JSON.stringify({ error: error.message, code: error.code || 'INTERNAL_ERROR' }), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
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
}

export function startRefloomServer(options = {}) {
  const server = createRefloomServer(options);
  const port = Number(options.port ?? process.env.PORT ?? 4173);
  const host = options.host ?? '127.0.0.1';

  server.once('error', error => {
    console.error(`Refloom could not start on http://${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`Refloom is available at http://${host}:${address.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) startRefloomServer();
