import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { captureWebsite } from '../../src/chrome-capture.js';

const fixtures = new URL('./fixtures/', import.meta.url);

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

function settings() {
  return {
    urlPolicy: 'loopback', mode: 'interactive-auto', interactionMode: 'passive',
    observationMs: 1_500, sampleIntervalMs: 250, representativeMoments: 3,
    stabilitySamples: 2, stabilityThreshold: 0, readinessMs: 250, settleMs: 0,
    overallTimeoutMs: 30_000
  };
}

test('real Chromium captures framed and worker-offscreen surfaces and classifies cross-origin frames', async t => {
  const [parent, child, offscreen] = await Promise.all([
    readFile(new URL('webgl-frame-parent.html', fixtures)),
    readFile(new URL('webgl-frame-child.html', fixtures)),
    readFile(new URL('webgl-offscreen-worker.html', fixtures))
  ]);
  const foreign = await listen((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(child);
  });
  const foreignPort = foreign.address().port;
  const server = await listen((request, response) => {
    const body = request.url === '/frame' ? parent : request.url === '/child' ? child :
      request.url === '/offscreen' ? offscreen : request.url === '/cross' ? Buffer.from(
        `<!doctype html><iframe src="http://127.0.0.1:${foreignPort}/child" width="620" height="340"></iframe>`
      ) : null;
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': body.length });
    response.end(body);
  });
  t.after(async () => { await close(server); await close(foreign); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const framedShots = [];
  const framed = await captureWebsite(`${base}/frame`, {
    ...settings(), onScreenshot: async shot => framedShots.push(shot)
  });
  assert.equal(framed.autoCapture.completionStatus, 'complete');
  assert.equal(framed.autoCapture.targetCanvas.originClass, 'same-origin');
  assert.equal(framed.autoCapture.targetCanvas.surfaceType, 'html-canvas');
  assert.equal(framed.autoCapture.targetCanvas.selector, '#framed-scene');
  assert.equal(framed.autoCapture.targetCanvas.frameUrl, `${base}/child`);
  assert.ok(framedShots.length >= 1);
  assert.ok(framedShots.every(shot => shot.targetCanvas.observationMethod === 'page-runtime-diagnostic'));

  const offscreenShots = [];
  const worker = await captureWebsite(`${base}/offscreen`, {
    ...settings(), onScreenshot: async shot => offscreenShots.push(shot)
  });
  assert.equal(worker.autoCapture.completionStatus, 'complete');
  assert.equal(worker.autoCapture.targetCanvas.surfaceType, 'offscreen-transferred');
  assert.equal(worker.autoCapture.targetCanvas.selector, '#worker-scene');
  assert.equal(worker.autoCapture.targetCanvas.observationMethod, 'composited-offscreen-transfer');
  assert.ok(offscreenShots.length >= 1);
  assert.ok(offscreenShots.every(shot => shot.targetCanvas.webglContext === true));

  const cross = await captureWebsite(`${base}/cross`, settings());
  assert.equal(cross.autoCapture.completionStatus, 'complete');
  assert.equal(cross.autoCapture.selectedMoments, 0);
  assert.ok(cross.autoCapture.warnings.includes('unsupported_cross_origin_surface'));
  assert.ok(cross.autoCapture.surfaceDiscovery.surfaces.some(item =>
    item.surfaceType === 'cross-origin-frame' && item.originClass === 'cross-origin' && item.supported === false));
});
