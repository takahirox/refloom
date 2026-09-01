import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  captureDiagnosticCode, captureWebsite, connectChromeCdp, findChrome, verifyChromeRuntime
} from '../src/chrome-capture.js';

test('reports a stable browser-unavailable diagnostic without exposing candidate paths', async () => {
  let failure;
  await assert.rejects(findChrome('/secret/browser', async () => { throw new Error('missing'); }), error => {
    failure = error;
    return error.message === 'Website capture failed.';
  });
  assert.equal(captureDiagnosticCode(failure), 'BROWSER_UNAVAILABLE');
  assert.doesNotMatch(failure.message, /secret|browser/);
});

test('connects to only the profile-published loopback CDP page endpoint', async () => {
  const commands = [];
  class FakeWebSocket {
    constructor(url) { this.url = url; this.listeners = new Map(); queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
    emit(name, value) { for (const listener of this.listeners.get(name) || []) listener(value); }
    send(text) {
      const command = JSON.parse(text); commands.push(command);
      const result = command.method === 'Runtime.evaluate' ? { result: { value: 'ready' } } : {};
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: command.id, result }) }));
    }
    close() { this.emit('close', {}); }
  }
  const cdp = await connectChromeCdp({}, {
    profile: '/isolated/profile',
    readFile: async filename => { assert.equal(filename, '/isolated/profile/DevToolsActivePort'); return '9222\n/devtools/browser/id\n'; },
    fetch: async url => ({ ok: true, json: async () => [{ id: 'page-one', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/one' }] }),
    WebSocket: FakeWebSocket
  });
  assert.equal(cdp.targetId, 'page-one');
  assert.equal(await cdp.evaluate('1 + 1'), 'ready');
  assert.equal(commands[0].method, 'Runtime.evaluate');
  await cdp.close();
});

test('drives bounded deterministic checkpoints and always cleans up', async () => {
  const calls = [];
  const removed = [];
  let proxyClosed = false;
  let processKilled = false;
  const callbacks = [];
  const process = new EventEmitter();
  process.kill = () => { processKilled = true; };
  const cdp = {
    send: async (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.captureScreenshot') return { data: Buffer.from(`png-${calls.length}`).toString('base64') };
      return {};
    },
    evaluate: async expression => {
      calls.push(['evaluate', expression]);
      if (expression.includes("getContext('webgl2')")) return true;
      return expression.startsWith('({')
        ? { title: 'Example', url: 'https://example.com/', width: 1440, height: 2700, viewportWidth: 1440, viewportHeight: 900 }
        : undefined;
    },
    waitFor: async () => {}, on() {}, close: async () => {}
  };
  const result = await captureWebsite('https://example.com', {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    executable: '/fake/chrome',
    fs: {
      access: async () => {}, mkdtemp: async () => '/tmp/refloom-test',
      rm: async value => removed.push(value)
    },
    spawn: (_file, args) => { calls.push(['spawn', args]); return process; },
    createProxy: () => ({
      listen: async () => ({ port: 43210 }),
      close: async () => { proxyClosed = true; }
    }),
    connectCdp: async () => cdp,
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
    settleMs: 0,
    readinessMs: 0,
    checkpoints: 3,
    onScreenshot: async screenshot => callbacks.push(screenshot),
    now: () => '2026-08-30T00:00:00.000Z'
  });
  assert.deepEqual(result.screenshots.map(value => value.y), [0, 900, 1800]);
  assert.deepEqual(callbacks.map(value => value.checkpoint), [
    { index: 0, y: 0, count: 3 },
    { index: 1, y: 900, count: 3 },
    { index: 2, y: 1800, count: 3 }
  ]);
  assert.deepEqual(callbacks[0].viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
  assert.equal(callbacks[0].originalUrl, 'https://example.com/');
  assert.equal(callbacks[0].finalUrl, 'https://example.com/');
  assert.equal(callbacks[0].title, 'Example');
  assert.equal(callbacks[0].domain, 'example.com');
  assert.equal(callbacks[0].capturedAt, '2026-08-30T00:00:00.000Z');
  assert.equal(callbacks[0].captureMethod, 'automated-browser');
  assert.equal(callbacks[0].captureStrategy, 'deterministic-scroll');
  assert.equal(calls.some(([method]) => method === 'Browser.setDownloadBehavior'), true);
  assert.equal(calls.some(([method]) => method === 'Network.setBypassServiceWorker'), true);
  const capabilityIndex = calls.findIndex(([method, value]) => method === 'evaluate' && value.includes("getContext('webgl2')"));
  const hookIndex = calls.findIndex(([method, value]) => method === 'Page.addScriptToEvaluateOnNewDocument' && value.source.includes('HTMLCanvasElement.prototype.getContext'));
  const navigationIndex = calls.findIndex(([method]) => method === 'Page.navigate');
  assert.notEqual(capabilityIndex, -1);
  assert.notEqual(hookIndex, -1);
  assert.equal(hookIndex < navigationIndex, true);
  assert.equal(capabilityIndex < navigationIndex, true);
  const args = calls.find(([method]) => method === 'spawn')[1];
  assert.equal(args.includes('--remote-debugging-port=0'), true);
  assert.equal(args.includes('--disable-quic'), true);
  assert.equal(args.some(value => value.includes('disable_non_proxied_udp')), true);
  assert.equal(args.includes('--headless=new'), true);
  assert.equal(args.includes('--use-gl=angle'), true);
  assert.equal(args.includes('--use-angle=gl'), true);
  assert.equal(args.includes('--ignore-gpu-blocklist'), true);
  assert.equal(args.includes('--no-sandbox'), false);
  assert.equal(args.includes('--disable-gpu-sandbox'), false);
  assert.equal(proxyClosed, true);
  assert.equal(processKilled, true);
  assert.deepEqual(removed, ['/tmp/refloom-test']);
});

test('browser runtime verification launches loopback CDP without external navigation and cleans up', async () => {
  const calls = [];
  let killed = false;
  let removed = false;
  const process = new EventEmitter();
  process.kill = () => { killed = true; };
  const verified = await verifyChromeRuntime({
    executable: '/runtime/chromium',
    fs: {
      access: async value => assert.equal(value, '/runtime/chromium'),
      mkdtemp: async () => '/tmp/refloom-browser-check',
      rm: async () => { removed = true; }
    },
    spawn: (file, args) => { calls.push({ file, args }); return process; },
    connectCdp: async () => ({
      send: async method => { calls.push({ method }); return {}; },
      evaluate: async expression => { calls.push({ expression }); return true; },
      close: async () => { calls.push({ method: 'close' }); }
    })
  });
  assert.equal(verified, true);
  assert.equal(calls[0].file, '/runtime/chromium');
  assert.equal(calls[0].args.includes('about:blank'), true);
  assert.equal(calls[0].args.includes('--disable-dev-shm-usage'), true);
  assert.equal(calls[0].args.includes('--headless=new'), true);
  assert.equal(calls[0].args.includes('--use-gl=angle'), true);
  assert.equal(calls[0].args.includes('--use-angle=gl'), true);
  assert.equal(calls[0].args.includes('--ignore-gpu-blocklist'), true);
  assert.equal(calls[0].args.includes('--no-sandbox'), false);
  assert.equal(calls[0].args.includes('--disable-gpu-sandbox'), false);
  assert.equal(calls.some(call => call.method === 'Browser.getVersion'), true);
  assert.equal(calls.some(call => call.expression?.includes("getContext('webgl2')")), true);
  assert.equal(killed, true);
  assert.equal(removed, true);
});

test('reports WebGL unavailability before navigation or screenshot persistence', async () => {
  const calls = [];
  const callbacks = [];
  let removed = false;
  let proxyClosed = false;
  let processKilled = false;
  let failure;
  const process = new EventEmitter();
  process.kill = () => { processKilled = true; };
  await assert.rejects(captureWebsite('https://example.com', {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    executable: '/fake/chrome',
    fs: {
      access: async () => {},
      mkdtemp: async () => '/tmp/refloom-webgl-test',
      rm: async () => { removed = true; }
    },
    spawn: () => process,
    createProxy: () => ({
      listen: async () => ({ port: 43210 }),
      close: async () => { proxyClosed = true; }
    }),
    connectCdp: async () => ({
      send: async method => { calls.push(method); return {}; },
      evaluate: async expression => {
        assert.equal(expression.includes("getContext('webgl2')"), true);
        return false;
      },
      close: async () => {}
    }),
    onScreenshot: async screenshot => callbacks.push(screenshot)
  }), error => {
    failure = error;
    return error.message === 'Website capture failed.';
  });
  assert.equal(captureDiagnosticCode(failure), 'WEBGL_UNAVAILABLE');
  assert.equal(calls.includes('Page.navigate'), false);
  assert.deepEqual(callbacks, []);
  assert.equal(proxyClosed, true);
  assert.equal(processKilled, true);
  assert.equal(removed, true);
});

test('page HTTP and WebGL runtime failures are diagnosed before screenshot callbacks', async t => {
  for (const scenario of [
    { name: 'main document HTTP failure', status: 404, webGlContextFailure: false },
    { name: 'page WebGL context failure', status: 200, webGlContextFailure: true }
  ]) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const callbacks = [];
      const listeners = new Map();
      const process = new EventEmitter();
      process.kill = () => {};
      let failure;
      const cdp = {
        targetId: 'target',
        send: async (method, params) => {
          calls.push([method, params]);
          if (method === 'Page.navigate') {
            listeners.get('Network.responseReceived')?.({
              type: 'Document', frameId: 'main-frame', response: { status: scenario.status }
            });
            return { frameId: 'main-frame' };
          }
          if (method === 'Page.captureScreenshot') throw new Error('screenshot must not run');
          return {};
        },
        evaluate: async expression => {
          calls.push(['evaluate', expression]);
          if (expression.includes("document.createElement('canvas')")) return true;
          if (expression.includes('refloom.pageRuntimeDiagnostic')) return scenario.webGlContextFailure;
          throw new Error('metrics must not run');
        },
        waitFor: async () => {},
        on(method, listener) { listeners.set(method, listener); },
        close: async () => {}
      };
      await assert.rejects(captureWebsite('https://example.com', {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        executable: '/fake/chrome',
        fs: {
          access: async () => {}, mkdtemp: async () => '/tmp/refloom-page-runtime-test',
          rm: async () => {}
        },
        spawn: () => process,
        createProxy: () => ({ listen: async () => ({ port: 43210 }), close: async () => {} }),
        connectCdp: async () => cdp,
        readinessMs: 0,
        onScreenshot: async screenshot => callbacks.push(screenshot)
      }), error => {
        failure = error;
        return error.message === 'Website capture failed.';
      });
      assert.equal(captureDiagnosticCode(failure), 'PAGE_RUNTIME_ERROR');
      assert.deepEqual(callbacks, []);
      assert.equal(calls.some(([method]) => method === 'Page.captureScreenshot'), false);
      assert.equal(calls.some(([method, expression]) => method === 'evaluate' && expression.startsWith('({')), false);
    });
  }
});

test('browser runtime verification reports the stable WebGL diagnostic', async () => {
  let killed = false;
  let removed = false;
  let failure;
  const process = new EventEmitter();
  process.kill = () => { killed = true; };
  await assert.rejects(verifyChromeRuntime({
    executable: '/runtime/chromium',
    fs: {
      access: async () => {},
      mkdtemp: async () => '/tmp/refloom-browser-check',
      rm: async () => { removed = true; }
    },
    spawn: () => process,
    connectCdp: async () => ({
      send: async () => ({}),
      evaluate: async () => false,
      close: async () => {}
    })
  }), error => {
    failure = error;
    return error.message === 'Website capture failed.';
  });
  assert.equal(captureDiagnosticCode(failure), 'WEBGL_UNAVAILABLE');
  assert.equal(killed, true);
  assert.equal(removed, true);
});

test('browser failures are generic, diagnosable, and cleanup remains guaranteed', async () => {
  let removed = false;
  let closed = false;
  let failure;
  await assert.rejects(captureWebsite('https://example.com', {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    executable: '/secret/path/chrome',
    fs: { access: async () => {}, mkdtemp: async () => '/secret/profile', rm: async () => { removed = true; } },
    spawn: () => ({ kill() {} }),
    createProxy: () => ({ listen: async () => ({ port: 1 }), close: async () => { closed = true; } }),
    connectCdp: async () => { throw new Error('/secret/path/chrome crashed'); }
  }), error => {
    failure = error;
    return error.message === 'Website capture failed.';
  });
  assert.equal(captureDiagnosticCode(failure), 'BROWSER_START_FAILED');
  assert.doesNotMatch(failure.message, /secret|chrome/);
  assert.equal(removed, true);
  assert.equal(closed, true);
});
