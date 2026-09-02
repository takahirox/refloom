import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUTO_ACTION_SCHEMA, PASSIVE_BLOCKED_ACTIONS, assertPassiveAutomationAction,
  findStableInitial, observeInteractiveAuto, selectRepresentativeMoments,
  selectTargetCanvas, validateInteractiveAutoSettings, visualChangeScore
} from '../src/interactive-auto.js';
import { normalizeCaptureRequest, publicCaptureResult } from '../src/capture-request.js';

const png = value => Buffer.from(`deterministic-png-${value}`).toString('base64');

test('detects the largest visible canvas with observable WebGL activity deterministically', () => {
  const selected = selectTargetCanvas([
    { domIndex: 0, visible: true, webglContext: false, drawCalls: 0, bounds: { width: 1000, height: 800 } },
    { domIndex: 1, visible: false, webglContext: true, drawCalls: 12, bounds: { width: 900, height: 700 } },
    { domIndex: 2, visible: true, webglContext: true, drawCalls: 2, bounds: { width: 400, height: 300 } },
    { domIndex: 3, visible: true, webglContext: true, drawCalls: 5, bounds: { width: 800, height: 600 } }
  ]);
  assert.equal(selected.domIndex, 3);
  assert.equal(selectTargetCanvas([]), null);
});

test('visual change, stability, and representative selection are deterministic', () => {
  assert.equal(visualChangeScore(png('same'), png('same')), 0);
  assert.ok(visualChangeScore(png('dark'), png('bright')) > 0);
  const samples = [
    { index: 0, png: png('a'), changeScore: 0 },
    { index: 1, png: png('a'), changeScore: 0 },
    { index: 2, png: png('a'), changeScore: 0 },
    { index: 3, png: png('b'), changeScore: visualChangeScore(png('a'), png('b')) },
    { index: 4, png: png('c'), changeScore: visualChangeScore(png('b'), png('c')) }
  ];
  const initial = findStableInitial(samples, { stabilitySamples: 3, stabilityThreshold: 0 });
  assert.equal(initial.index, 2);
  assert.equal(initial.selectionReason, 'initial_stable');
  const selected = selectRepresentativeMoments(samples, initial, 3);
  assert.deepEqual(selected.map(item => item.index), [3, 4]);
  assert.ok(selected.every(item => item.selectionScore > 0));
});

test('validation enforces hard observation limits and passive-only automation', () => {
  assert.deepEqual(validateInteractiveAutoSettings({}), {
    interactionMode: 'passive', observationMs: 10_000, sampleIntervalMs: 500,
    representativeMoments: 4, stabilitySamples: 3, stabilityThreshold: 0.015
  });
  assert.throws(() => validateInteractiveAutoSettings({ interactionMode: 'guided' }), /Only passive/);
  assert.throws(() => validateInteractiveAutoSettings({ observationMs: 30_001 }), /bounded limits/);
  assert.throws(() => validateInteractiveAutoSettings({ observationMs: 10_000, sampleIntervalMs: 100 }), /bounded limits/);
  assert.throws(() => normalizeCaptureRequest({
    referenceId: 'r', settings: { mode: 'viewport', observationMs: 1_000 }
  }), /invalid/i);
});

test('passive safety policy blocks every unsafe action and leaves guided/explore disabled', () => {
  for (const action of PASSIVE_BLOCKED_ACTIONS) {
    assert.throws(() => assertPassiveAutomationAction(action), /Passive capture blocks/);
  }
  for (const action of ['observe', 'wait', 'capture']) assert.equal(assertPassiveAutomationAction(action), true);
  assert.equal(AUTO_ACTION_SCHEMA.modes.passive.enabled, true);
  assert.equal(AUTO_ACTION_SCHEMA.modes.guided.enabled, false);
  assert.equal(AUTO_ACTION_SCHEMA.modes.explore.enabled, false);
});

test('bounded observer returns an explicit graceful non-WebGL result', async () => {
  const result = await observeInteractiveAuto({
    evaluate: async () => [{
      domIndex: 0, visible: true, webglContext: false, drawCalls: 0,
      bounds: { x: 0, y: 0, width: 640, height: 480 }
    }]
  }, {
    observationMs: 1_000, sampleIntervalMs: 500, representativeMoments: 3,
    stabilitySamples: 2, stabilityThreshold: 0,
    active() {}, checkpointMs: 100, maxScreenshotBytes: 1_000,
    maxObservationBytes: 2_000, pause: async () => {},
    bounded: promise => promise
  });
  assert.deepEqual(result.screenshots, []);
  assert.equal(result.autoCapture.completionStatus, 'complete');
  assert.deepEqual(result.autoCapture.warnings, ['non_webgl_canvas']);
});

test('bounded observer selects a stable initial frame and distinct moments', async () => {
  let screenshot = 0;
  const values = ['a', 'a', 'a', 'b', 'c'];
  const cdp = {
    evaluate: async () => [{
      domIndex: 0, selector: '#scene', visible: true, webglContext: true,
      contextType: 'webgl2', drawCalls: 10,
      bounds: { x: 0, y: 0, width: 640, height: 480 }
    }],
    send: async method => {
      assert.equal(method, 'Page.captureScreenshot');
      return { data: png(values[screenshot++] ?? 'c') };
    }
  };
  const result = await observeInteractiveAuto(cdp, {
    observationMs: 1_000, sampleIntervalMs: 250, representativeMoments: 3,
    stabilitySamples: 3, stabilityThreshold: 0,
    active() {}, checkpointMs: 100, maxScreenshotBytes: 1_000,
    maxObservationBytes: 5_000, pause: async () => {},
    bounded: promise => promise
  });
  assert.equal(result.screenshots[0].selectionReason, 'initial_stable');
  assert.ok(result.screenshots.slice(1).every(item => item.selectionReason === 'representative_visual_change'));
  assert.equal(result.autoCapture.targetCanvas.selector, '#scene');
  assert.equal(result.autoCapture.selectedMoments, 3);
  assert.ok(result.screenshots.every(item => item.automation.actions.every(
    action => Number.isSafeInteger(action.relativeTimestampMs)
  )));
  assert.equal(
    result.screenshots.at(-1).automation.actions.at(-1).detail.targetSelector,
    '#scene'
  );
});

test('observation failure retains useful frames as a bounded partial result', async () => {
  let evaluations = 0;
  const result = await observeInteractiveAuto({
    evaluate: async () => {
      if (evaluations++ > 0) throw new Error('bounded observation timeout');
      return [{
        domIndex: 0,
        selector: '#scene',
        visible: true,
        webglContext: true,
        contextType: 'webgl2',
        drawCalls: 1,
        bounds: { x: 0, y: 0, width: 640, height: 480 }
      }];
    },
    send: async () => ({ data: png('useful') })
  }, {
    observationMs: 1_000,
    sampleIntervalMs: 500,
    representativeMoments: 3,
    stabilitySamples: 2,
    stabilityThreshold: 0,
    active() {},
    checkpointMs: 100,
    maxScreenshotBytes: 1_000,
    maxObservationBytes: 2_000,
    pause: async () => {},
    bounded: promise => promise
  });
  assert.equal(result.autoCapture.completionStatus, 'partial');
  assert.equal(result.screenshots.length, 1);
  assert.ok(result.autoCapture.warnings.includes('observation_failure'));

  await assert.rejects(observeInteractiveAuto({
    evaluate: async () => { throw new Error('no useful frame'); }
  }, {
    observationMs: 1_000,
    sampleIntervalMs: 500,
    representativeMoments: 3,
    stabilitySamples: 2,
    stabilityThreshold: 0,
    active() {},
    checkpointMs: 100,
    maxScreenshotBytes: 1_000,
    maxObservationBytes: 2_000,
    pause: async () => {},
    bounded: promise => promise
  }), /no useful frame/);
});

test('cancellation interrupts observation instead of returning a successful result', async () => {
  const controller = new AbortController();
  let iterations = 0;
  await assert.rejects(observeInteractiveAuto({
    evaluate: async () => {
      iterations += 1;
      if (iterations === 2) controller.abort();
      return [];
    }
  }, {
    observationMs: 1_000, sampleIntervalMs: 500, representativeMoments: 3,
    stabilitySamples: 2, stabilityThreshold: 0, signal: controller.signal,
    active() { if (controller.signal.aborted) throw new Error('cancelled'); },
    checkpointMs: 100, maxScreenshotBytes: 1_000,
    maxObservationBytes: 2_000, pause: async () => {},
    bounded: promise => promise
  }), /cancelled/);
});

test('HTTP/UI and MCP public result contract includes the same bounded auto summary', () => {
  const request = normalizeCaptureRequest({ referenceId: 'r', settings: {
    mode: 'interactive-auto', interactionMode: 'passive', observationMs: 5_000,
    sampleIntervalMs: 500, representativeMoments: 4
  } });
  assert.equal(request.settings.mode, 'interactive-auto');
  const result = publicCaptureResult({
    status: 'complete', captured: [{ assetId: 'a', targetId: 't', momentId: 'm', mediaId: 'private' }],
    summary: { autoCapture: { interactionMode: 'passive', completionStatus: 'complete', warnings: [] } }
  });
  assert.deepEqual(result, {
    status: 'complete', captured: [{ assetId: 'a', targetId: 't', momentId: 'm' }],
    autoCapture: { interactionMode: 'passive', completionStatus: 'complete', warnings: [] }
  });
});

test('deterministic local WebGL fixture performs rendering without input handlers', async () => {
  const fixture = await readFile(
    new URL('./integration/fixtures/webgl-passive.html', import.meta.url),
    'utf8'
  );
  assert.match(fixture, /getContext\('webgl2'/);
  assert.match(fixture, /drawArrays/);
  assert.doesNotMatch(fixture, /addEventListener|\.click\(|dispatchEvent|requestPointerLock/);
});
