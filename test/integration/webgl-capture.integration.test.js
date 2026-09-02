import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { captureWebsite } from '../../src/chrome-capture.js';

const fixtureUrl = new URL('./fixtures/webgl-passive.html', import.meta.url);

test('real Chromium passively captures representative WebGL moments', async t => {
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
    interactionMode: 'passive',
    observationMs: 1_500,
    sampleIntervalMs: 250,
    representativeMoments: 3,
    stabilitySamples: 2,
    stabilityThreshold: 0,
    readinessMs: 0,
    settleMs: 0,
    overallTimeoutMs: 30_000,
    onScreenshot: async screenshot => captured.push(screenshot)
  });

  assert.equal(result.autoCapture.interactionMode, 'passive');
  assert.equal(result.autoCapture.completionStatus, 'complete');
  assert.ok(result.autoCapture.observedSamples >= 3);
  assert.ok(captured.length >= 3 && captured.length <= 5);
  assert.equal(captured.length, result.autoCapture.selectedMoments);
  assert.ok(captured.every(item => item.captureStrategy === 'passive-webgl-observation'));
  assert.ok(captured.every(item => item.targetCanvas.selector === '#scene'));
  assert.ok(captured.every(item => item.blockedActions.includes('click')));
  assert.ok(captured.every(item => item.automation.interactionMode === 'passive'));
  assert.ok(captured.every(item => item.automation.actionSchema.modes.guided.enabled === false));
});
