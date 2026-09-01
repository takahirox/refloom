import http from 'node:http';
import net from 'node:net';
import { CAPTURE_ERROR, normalizeCaptureUrl, resolvePublicHost } from './capture-url.js';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function cleanHeaders(headers) {
  const connection = String(headers.connection || '').toLowerCase().split(',').map(value => value.trim());
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(name.toLowerCase()) && !connection.includes(name.toLowerCase())) result[name] = value;
  }
  return result;
}

export function createCaptureProxy(options = {}) {
  const resolver = options.resolver;
  const connect = options.connect || (settings => net.connect(settings));
  const request = options.request || (settings => http.request(settings));
  const limits = {
    bytes: options.maxBytes ?? 100 * 1024 * 1024,
    connections: options.maxConnections ?? 64,
    connectMs: options.connectTimeoutMs ?? 5_000,
    requestMs: options.requestTimeoutMs ?? 15_000,
    idleMs: options.idleTimeoutMs ?? 5_000
  };
  const sockets = new Set();
  let usedBytes = 0;
  let opened = 0;
  let closed = false;

  function consume(chunk) {
    usedBytes += chunk.length;
    if (usedBytes > limits.bytes) throw new Error(CAPTURE_ERROR);
  }

  function admit(socket) {
    if (closed || sockets.size >= limits.connections) {
      socket.destroy();
      throw new Error(CAPTURE_ERROR);
    }
    opened++;
    sockets.add(socket);
    socket.setTimeout?.(limits.idleMs, () => socket.destroy());
    socket.once?.('close', () => sockets.delete(socket));
    return socket;
  }

  function genericError(client, status = 502) {
    if (client.headersSent) client.destroy();
    else client.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(CAPTURE_ERROR);
  }

  const server = http.createServer(async (clientRequest, clientResponse) => {
    try {
      const target = await normalizeCaptureUrl(clientRequest.url, { resolver });
      const pinned = target.answers[0];
      const upstream = admit(request({
        protocol: target.url.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: target.port,
        method: clientRequest.method,
        path: `${target.url.pathname}${target.url.search}`,
        headers: { ...cleanHeaders(clientRequest.headers), host: target.url.host },
        servername: target.hostname,
        timeout: limits.requestMs
      }));
      upstream.once('timeout', () => upstream.destroy(new Error(CAPTURE_ERROR)));
      upstream.once('error', () => genericError(clientResponse));
      upstream.once('response', response => {
        clientResponse.writeHead(response.statusCode || 502, cleanHeaders(response.headers));
        response.on('data', chunk => {
          try { consume(chunk); } catch { response.destroy(); clientResponse.destroy(); }
        });
        response.pipe(clientResponse);
      });
      clientRequest.on('data', chunk => {
        try { consume(chunk); } catch { clientRequest.destroy(); upstream.destroy(); }
      });
      clientRequest.pipe(upstream);
    } catch {
      genericError(clientResponse, 403);
    }
  });
  server.on('connection', socket => socket.on('error', () => {}));

  server.on('upgrade', async (req, clientSocket, head) => {
    let upstream;
    try {
      const candidate = new URL(req.url);
      if (candidate.protocol !== 'ws:' || String(req.headers.upgrade).toLowerCase() !== 'websocket') throw new Error(CAPTURE_ERROR);
      candidate.protocol = 'http:';
      const target = await normalizeCaptureUrl(candidate.href, { resolver });
      const pinned = target.answers[0];
      upstream = admit(connect({ host: pinned.address, port: 80, family: pinned.family, timeout: limits.connectMs }));
      upstream.once('connect', () => {
        const headers = { ...cleanHeaders(req.headers), host: target.url.host, connection: 'Upgrade', upgrade: 'websocket' };
        const lines = [`${req.method} ${target.url.pathname}${target.url.search} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) lines.push(`${name}: ${item}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) { consume(head); upstream.write(head); }
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.on('data', chunk => { try { consume(chunk); } catch { upstream.destroy(); clientSocket.destroy(); } });
      clientSocket.on('data', chunk => { try { consume(chunk); } catch { upstream.destroy(); clientSocket.destroy(); } });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
      admit(clientSocket);
    } catch {
      upstream?.destroy?.();
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    try {
      const separator = req.url.lastIndexOf(':');
      if (separator < 1) throw new Error(CAPTURE_ERROR);
      const host = req.url.slice(0, separator).replace(/^\[|\]$/g, '');
      const port = Number(req.url.slice(separator + 1));
      if (port !== 443) throw new Error(CAPTURE_ERROR);
      const answers = await resolvePublicHost(host, resolver);
      const pinned = answers[0];
      const upstream = admit(connect({
        host: pinned.address, port, family: pinned.family, timeout: limits.connectMs
      }));
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      });
      upstream.on('data', chunk => {
        try { consume(chunk); } catch { upstream.destroy(); clientSocket.destroy(); }
      });
      clientSocket.on('data', chunk => {
        try { consume(chunk); } catch { upstream.destroy(); clientSocket.destroy(); }
      });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
      admit(clientSocket);
    } catch {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      return server.address();
    },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
    stats: () => ({ usedBytes, opened })
  };
}
