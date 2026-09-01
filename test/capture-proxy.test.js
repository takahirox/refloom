import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCaptureProxy } from '../src/capture-proxy.js';

class FakeRequest extends EventEmitter {
  setTimeout() {}
  write() {}
  end() {}
  destroy() { this.emit('close'); }
}

function complete(request, statusCode = 204) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = {};
  response.pipe = destination => destination.end();
  request.emit('response', response);
  request.emit('close');
}

test('pins the validated DNS address and strips proxy credentials', async t => {
  const seen = [];
  let resolution = 0;
  const resolver = async () => [{ address: ++resolution === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
  const proxy = createCaptureProxy({
    resolver,
    request(options) {
      seen.push(options);
      const request = new FakeRequest();
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 204;
        response.headers = {};
        response.pipe = destination => destination.end();
        request.emit('response', response);
      });
      return request;
    }
  });
  const address = await proxy.listen();
  t.after(() => proxy.close());
  const http = await import('node:http');
  const send = () => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: address.port,
      path: 'http://example.com/resource',
      headers: { 'proxy-authorization': 'secret' }
    }, result => { result.resume(); result.once('end', resolve); });
    request.once('error', reject);
    request.end();
  });
  await send();
  assert.equal(seen.at(-1).hostname, '93.184.216.34');
  assert.equal(seen.at(-1).headers.host, 'example.com');
  assert.equal(seen.at(-1).headers['proxy-authorization'], undefined);
  assert.equal(resolution, 1);
  await send();
  assert.equal(seen.length, 1, 'a later private DNS answer is rejected instead of replacing the pinned address');
});

test('rejects a mixed public and private DNS response before connecting', async t => {
  let connected = false;
  const proxy = createCaptureProxy({
    resolver: async () => [
      { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }
    ],
    request() { connected = true; return new FakeRequest(); }
  });
  const address = await proxy.listen();
  t.after(() => proxy.close());
  const http = await import('node:http');
  const status = await new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: address.port, path: 'http://example.com/' }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.end();
  });
  assert.equal(status, 403);
  assert.equal(connected, false);
});

test('releases a connection slot when an admitted socket closes', async t => {
  const upstreams = [];
  const proxy = createCaptureProxy({
    maxConnections: 1,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    request() {
      const upstream = new FakeRequest();
      upstreams.push(upstream);
      queueMicrotask(() => complete(upstream));
      return upstream;
    }
  });
  const address = await proxy.listen();
  t.after(() => proxy.close());
  const http = await import('node:http');
  const send = () => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: address.port, path: 'http://example.com/'
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });

  assert.equal(await send(), 204);
  assert.equal(await send(), 204);
  assert.equal(upstreams.length, 2);
});

test('rejects a connection while all slots are concurrently occupied', async t => {
  const upstreams = [];
  let notifyFirst;
  const firstCreated = new Promise(resolve => { notifyFirst = resolve; });
  const proxy = createCaptureProxy({
    maxConnections: 1,
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    request() {
      const upstream = new FakeRequest();
      upstreams.push(upstream);
      if (upstreams.length === 1) notifyFirst();
      return upstream;
    }
  });
  const address = await proxy.listen();
  t.after(() => proxy.close());
  const http = await import('node:http');
  const send = () => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: address.port, path: 'http://example.com/'
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });

  const first = send();
  await firstCreated;
  assert.equal(await send(), 403);
  assert.equal(upstreams.length, 2);

  complete(upstreams[0]);
  assert.equal(await first, 204);
});
