import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CDP_SURFACE_LIMITS, inspectCdpSurfaceTargets
} from '../src/cdp-surface-targets.js';

const MAIN = 'https://example.test/game';

function surface(overrides = {}) {
  return {
    frameId: 'frame-a', frameUrl: MAIN, originClass: 'same-origin',
    surfaceType: 'html-canvas', selector: '#scene', targetIdentity: 'scene',
    observationMethod: 'page-runtime-diagnostic',
    bounds: { x: 0, y: 0, width: 640, height: 360 }, visible: true,
    webglContext: true, drawCalls: 2, supported: true, domIndex: 0, depth: 0,
    ...overrides
  };
}

function options() {
  return { mainUrl: MAIN, bounded: promise => promise };
}

test('exports frozen CDP target limits', () => {
  assert.deepEqual(CDP_SURFACE_LIMITS, {
    maxTargets: 8, timeoutMs: 2_000, maxResponseBytes: 262_144
  });
  assert.ok(Object.isFrozen(CDP_SURFACE_LIMITS));
});

test('classifies cross-origin OOPIF and workers without attaching', async () => {
  const calls = [];
  const cdp = { send: async (...args) => {
    calls.push(args);
    return { targetInfos: [
      { targetId: 'oopif', type: 'iframe', url: 'https://other.test/frame' },
      { targetId: 'worker', type: 'worker', url: 'https://example.test/worker.js' },
      { targetId: 'ignored', type: 'page', url: MAIN }
    ] };
  } };
  const result = await inspectCdpSurfaceTargets(cdp, options());
  assert.deepEqual(result.classifications.map(item => [item.targetId, item.originClass, item.attached]), [
    ['oopif', 'cross-origin', false], ['worker', 'same-origin', false]
  ]);
  assert.deepEqual(result.warnings, ['unsupported_cross_origin_oopif', 'worker_surface_detected']);
  assert.deepEqual(calls.map(([method]) => method), ['Target.getTargets']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.classifications[0]));
});

test('attaches only a same-origin iframe with a fixed expression and always detaches', async () => {
  const calls = [];
  const cdp = { send: async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [
      { targetId: 'same', type: 'iframe', url: 'https://example.test/frame' }
    ] };
    if (method === 'Target.attachToTarget') return { sessionId: 'private-session' };
    if (method === 'Runtime.evaluate') return { result: { value: {
      surfaces: [surface()], warnings: []
    } } };
    if (method === 'Target.detachFromTarget') return {};
    throw new Error('unexpected method');
  } };
  const result = await inspectCdpSurfaceTargets(cdp, options());
  assert.equal(result.classifications[0].attached, true);
  assert.equal(result.attached[0].surfaces[0].selector, '#scene');
  assert.deepEqual(calls.map(item => item.method), [
    'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate', 'Target.detachFromTarget'
  ]);
  assert.equal(calls[2].sessionId, 'private-session');
  assert.match(calls[2].params.expression, /MAX_SURFACES = 32/);
  assert.equal(JSON.stringify(result).includes('private-session'), false);
});

test('evaluation and cleanup failures remain bounded and explicit', async () => {
  const calls = [];
  const cdp = { send: async (method) => {
    calls.push(method);
    if (method === 'Target.getTargets') return { targetInfos: [
      { targetId: 'same', type: 'iframe', url: 'https://example.test/frame' }
    ] };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    throw new Error('bounded failure');
  } };
  const result = await inspectCdpSurfaceTargets(cdp, options());
  assert.deepEqual(result.warnings, ['cdp_attachment_failed', 'cdp_cleanup_failed']);
  assert.deepEqual(calls, [
    'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate', 'Target.detachFromTarget'
  ]);
});

test('caps target work and rejects invalid untrusted responses/options', async () => {
  const targetInfos = Array.from({ length: 10 }, (_, index) => ({
    targetId: `z-${index}`, type: 'worker', url: `https://example.test/w${index}.js`
  }));
  const result = await inspectCdpSurfaceTargets({
    send: async () => ({ targetInfos })
  }, options());
  assert.equal(result.classifications.length, CDP_SURFACE_LIMITS.maxTargets);
  assert.equal(result.warnings[0], 'cdp_target_limit_exceeded');

  assert.deepEqual(await inspectCdpSurfaceTargets({ send: async () => ({}) }, options()), {
    classifications: [], attached: [], warnings: ['cdp_target_discovery_invalid']
  });
  await assert.rejects(inspectCdpSurfaceTargets(null, options()), /Invalid CDP surface options/);
  await assert.rejects(inspectCdpSurfaceTargets({ send() {} }, { ...options(), mainUrl: 'file:///tmp/x' }),
    /Invalid CDP surface options/);
});
