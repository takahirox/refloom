import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const types = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8']]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
  return createServer(async (request, response) => {
    response.on('error', () => {});

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    let asset;
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
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
