import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SURFACE_LIMITS,
  normalizeWebGlSurfaces,
  selectWebGlSurface,
  webGlSurfaceWarnings,
} from '../src/webgl-surfaces.js';

const URL = 'https://example.test/scene';

function surface(overrides = {}) {
  return {
    frameId: 'frame-1',
    frameUrl: URL,
    originClass: 'main',
    surfaceType: 'html-canvas',
    selector: '#scene',
    targetIdentity: 'canvas-1',
    observationMethod: 'runtime',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    visible: true,
    webglContext: true,
    drawCalls: 10,
    supported: true,
    domIndex: 0,
    depth: 0,
    ...overrides,
  };
}

function assertTypeError(fn) {
  assert.throws(fn, (error) => {
    assert.equal(Object.getPrototypeOf(error), TypeError.prototype);
    return true;
  });
}

test('exports the exact frozen surface limits', () => {
  assert.deepEqual(SURFACE_LIMITS, { maxFrames: 8, maxSurfaces: 32, maxDepth: 3 });
  assert.ok(Object.isFrozen(SURFACE_LIMITS));
});

test('normalizes exact untrusted records and deeply freezes the result', () => {
  const input = [surface({ bounds: { x: 4, y: 5, width: 640, height: 480 } })];
  const before = structuredClone(input);
  const result = normalizeWebGlSurfaces(input);

  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.notEqual(result[0], input[0]);
  assert.notEqual(result[0].bounds, input[0].bounds);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.ok(Object.isFrozen(result[0].bounds));
  assert.deepEqual(input, before);
  assert.throws(() => { result[0].bounds.width = 1; }, TypeError);
});

test('accepts null-prototype records but rejects non-exact records and containers', () => {
  const record = Object.assign(Object.create(null), surface());
  assert.equal(normalizeWebGlSurfaces([record]).length, 1);

  for (const value of [null, {}, 'surfaces', 1, [null], [surface({ extra: true })]]) {
    assertTypeError(() => normalizeWebGlSurfaces(value));
  }
  const missing = surface();
  delete missing.selector;
  assertTypeError(() => normalizeWebGlSurfaces([missing]));

  const boundsExtra = surface({ bounds: { x: 0, y: 0, width: 1, height: 1, extra: 0 } });
  assertTypeError(() => normalizeWebGlSurfaces([boundsExtra]));
});

test('rejects unsafe URLs, control characters, types, and bounds', () => {
  for (const value of [
    surface({ frameUrl: 'not-a-url' }),
    surface({ frameUrl: 'https://example.test/\u0000' }),
    surface({ frameId: '' }),
    surface({ frameId: 'bad\u001fvalue' }),
    surface({ frameId: 1 }),
    surface({ originClass: 'unknown' }),
    surface({ surfaceType: 'unknown' }),
    surface({ observationMethod: '' }),
    surface({ visible: 1 }),
    surface({ webglContext: 'yes' }),
    surface({ supported: null }),
    surface({ drawCalls: -1 }),
    surface({ drawCalls: 1.5 }),
    surface({ domIndex: Number.POSITIVE_INFINITY }),
    surface({ depth: -1 }),
    surface({ bounds: { x: -1, y: 0, width: 1, height: 1 } }),
    surface({ bounds: { x: 0, y: 0, width: Number.NaN, height: 1 } }),
    surface({ bounds: { x: 0, y: 0, width: 1, height: '1' } }),
    surface({ bounds: { x: 0, y: 0, width: 1, height: 1 }, selector: '\u007f' }),
  ]) assertTypeError(() => normalizeWebGlSurfaces([value]));
});

test('enforces depth, surface, and distinct-frame caps', () => {
  assertTypeError(() => normalizeWebGlSurfaces([surface({ depth: SURFACE_LIMITS.maxDepth + 1 })]));
  assertTypeError(() => normalizeWebGlSurfaces(
    Array.from({ length: SURFACE_LIMITS.maxSurfaces + 1 }, () => surface()),
  ));
  assertTypeError(() => normalizeWebGlSurfaces(
    Array.from({ length: SURFACE_LIMITS.maxFrames + 1 }, (_, index) =>
      surface({ frameId: `frame-${index}` })),
  ));
});

test('selects only visible supported WebGL HTML and transferred offscreen canvases', () => {
  const excluded = [
    surface({ targetIdentity: 'unsupported', supported: false, bounds: { x: 0, y: 0, width: 900, height: 900 } }),
    surface({ targetIdentity: 'invisible', visible: false, bounds: { x: 0, y: 0, width: 800, height: 800 } }),
    surface({ targetIdentity: 'non-webgl', webglContext: false, bounds: { x: 0, y: 0, width: 700, height: 700 } }),
    surface({ targetIdentity: 'cross-origin-type', surfaceType: 'cross-origin-frame', bounds: { x: 0, y: 0, width: 600, height: 600 } }),
    surface({ targetIdentity: 'worker-only', surfaceType: 'worker-offscreen', bounds: { x: 0, y: 0, width: 500, height: 500 } }),
  ];
  const transferred = surface({
    targetIdentity: 'transferred', surfaceType: 'offscreen-transferred',
    bounds: { x: 0, y: 0, width: 20, height: 20 },
  });
  assert.equal(selectWebGlSurface([...excluded, transferred]).targetIdentity, 'transferred');
  assert.equal(selectWebGlSurface(excluded), null);
});

test('ranks area, draw calls, origin, depth, frame, DOM index, then identity', () => {
  const choose = (left, right) => selectWebGlSurface([
    surface({ targetIdentity: 'left', ...left }),
    surface({ targetIdentity: 'right', ...right }),
  ]).targetIdentity;

  assert.equal(choose(
    { bounds: { x: 0, y: 0, width: 11, height: 10 } },
    { bounds: { x: 0, y: 0, width: 10, height: 10 }, drawCalls: 999 },
  ), 'left');
  assert.equal(choose({ drawCalls: 11 }, { drawCalls: 10 }), 'left');
  assert.equal(choose({ originClass: 'main' }, { originClass: 'same-origin' }), 'left');
  assert.equal(choose({ depth: 0 }, { depth: 1 }), 'left');
  assert.equal(choose({ frameId: 'a-frame' }, { frameId: 'b-frame' }), 'left');
  assert.equal(choose({ domIndex: 0 }, { domIndex: 1 }), 'left');
  assert.equal(choose({ targetIdentity: 'a-target' }, { targetIdentity: 'b-target' }), 'a-target');

  const selected = selectWebGlSurface([
    surface({ targetIdentity: 'low', bounds: { x: 0, y: 0, width: 2, height: 2 } }),
    surface({ targetIdentity: 'high', bounds: { x: 0, y: 0, width: 3, height: 3 } }),
  ]);
  assert.ok(Object.isFrozen(selected));
  assert.ok(Object.isFrozen(selected.bounds));
});

test('classifies cross-origin, opaque, and OOPIF surfaces with one stable warning', () => {
  const records = [
    surface({ originClass: 'cross-origin', surfaceType: 'cross-origin-frame' }),
    surface({ originClass: 'opaque', frameId: 'opaque-frame', surfaceType: 'cross-origin-frame' }),
  ];
  assert.deepEqual(webGlSurfaceWarnings(records), [
    'unsupported_cross_origin_surface', 'no_supported_surface'
  ]);
});

test('warns for a worker offscreen surface without a transferred visible canvas', () => {
  const worker = surface({ surfaceType: 'worker-offscreen', targetIdentity: 'worker' });
  assert.deepEqual(webGlSurfaceWarnings([worker]), [
    'worker_offscreen_without_transferred_visible_canvas',
    'no_supported_surface',
  ]);

  const transferred = surface({ surfaceType: 'offscreen-transferred', targetIdentity: 'transfer' });
  assert.deepEqual(webGlSurfaceWarnings([worker, transferred]), []);
});

test('returns limit warnings before unsafe normalization and deduplicates them', () => {
  const oversized = Array.from({ length: SURFACE_LIMITS.maxSurfaces + 1 }, (_, index) => ({
    frameId: `frame-${index}`,
    depth: SURFACE_LIMITS.maxDepth + 1,
  }));
  assert.deepEqual(webGlSurfaceWarnings(oversized), [
    'surface_limit_exceeded',
    'frame_limit_exceeded',
    'depth_limit_exceeded',
  ]);

  const repeated = [
    surface({ originClass: 'cross-origin', surfaceType: 'cross-origin-frame' }),
    surface({ originClass: 'opaque', frameId: 'frame-2', surfaceType: 'cross-origin-frame' }),
    surface({ frameId: 'frame-3', surfaceType: 'worker-offscreen' }),
  ];
  assert.deepEqual(webGlSurfaceWarnings(repeated), [
    'unsupported_cross_origin_surface',
    'worker_offscreen_without_transferred_visible_canvas',
    'no_supported_surface',
  ]);
});

test('warns when no supported surface exists and rejects non-arrays', () => {
  assert.deepEqual(webGlSurfaceWarnings([
    surface({ supported: false }),
    surface({ frameId: 'frame-2', visible: false }),
    surface({ frameId: 'frame-3', webglContext: false }),
  ]), ['no_supported_surface']);
  assertTypeError(() => webGlSurfaceWarnings(null));
  assertTypeError(() => webGlSurfaceWarnings({}));
});

test('selection and warnings do not mutate caller-owned records', () => {
  const input = [surface({ bounds: { x: 1, y: 2, width: 3, height: 4 } })];
  const before = structuredClone(input);
  selectWebGlSurface(input);
  webGlSurfaceWarnings(input);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input[0]), false);
  assert.equal(Object.isFrozen(input[0].bounds), false);
});
