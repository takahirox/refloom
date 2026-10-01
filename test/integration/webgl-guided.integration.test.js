import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { captureWebsite } from '../../src/chrome-capture.js';

const fixtureUrl = new URL('./fixtures/webgl-guided.html', import.meta.url);

test('real Chromium captures guided WebGL moments after Start', async t => {
  const fixture = await readFile(fixtureUrl);
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': fixture.length
    });
    response.end(fixture);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const port = server.address().port;
  assert.ok(Number.isSafeInteger(port) && port >= 1024);
  const captured = [];
  const result = await captureWebsite(`http://127.0.0.1:${port}/`, {
    urlPolicy: 'loopback',
    mode: 'interactive-auto',
    interactionMode: 'guided',
    guidedActions: [{ type: 'click', role: 'button', label: 'Start' }],
    observationMs: 1_500,
    sampleIntervalMs: 250,
    representativeMoments: 3,
    stabilitySamples: 2,
    stabilityThreshold: 1,
    readinessMs: 0,
    settleMs: 0,
    overallTimeoutMs: 30_000,
    onScreenshot: async screenshot => captured.push(screenshot)
  });

  assert.equal(result.mode, 'interactive-auto');
  assert.equal(result.autoCapture.interactionMode, 'guided');
  assert.equal(result.autoCapture.completionStatus, 'complete');
  assert.deepEqual(result.autoCapture.warnings, []);
  assert.deepEqual(result.autoCapture.automation.warnings, []);

  const actions = result.autoCapture.automation.actions;
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    order: 0,
    type: 'click',
    target: {
      role: 'button',
      label: 'Start',
      documentUrl: `http://127.0.0.1:${port}/`
    },
    relativeTimestampMs: actions[0].relativeTimestampMs,
    outcome: 'executed',
    policyReason: 'allowed'
  });
  assert.ok(Number.isSafeInteger(actions[0].relativeTimestampMs));
  assert.ok(actions[0].relativeTimestampMs >= 0);
  assert.equal(result.autoCapture.targetCanvas.selector, '#scene');
  assert.equal(result.autoCapture.targetCanvas.visible, true);
  assert.equal(result.autoCapture.targetCanvas.webglContext, true);

  assert.ok(captured.length >= 1);
  assert.ok(captured.every(item => item.targetCanvas.selector === '#scene'));
  assert.ok(captured.every(item => item.targetCanvas.visible === true));
  assert.ok(captured.every(item => item.targetCanvas.webglContext === true));
  assert.ok(captured.every(item => item.automation.interactionMode === 'guided'));
  assert.ok(captured.every(item => item.automation.actions.length === 1));
  assert.ok(captured.every(item => item.automation.actions[0].outcome === 'executed'));
  assert.ok(captured.every(item => item.automation.actions[0].policyReason === 'allowed'));
  assert.ok(captured.every(item => Array.isArray(item.png) || typeof item.png === 'string'));
  assert.ok(captured.every(item => item.warnings.length === 0));
});
