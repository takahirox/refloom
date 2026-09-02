export const SURFACE_LIMITS = Object.freeze({
  maxFrames: 8,
  maxSurfaces: 32,
  maxDepth: 3
});

const ORIGIN_CLASSES = new Set(['main', 'same-origin', 'cross-origin', 'opaque']);
const SURFACE_TYPES = new Set([
  'html-canvas', 'offscreen-transferred', 'cross-origin-frame', 'worker-offscreen'
]);
const REQUIRED_FIELDS = [
  'frameId', 'frameUrl', 'originClass', 'surfaceType', 'selector', 'targetIdentity',
  'observationMethod', 'bounds', 'visible', 'webglContext', 'drawCalls', 'supported',
  'domIndex', 'depth'
];
const BOUNDS_FIELDS = ['x', 'y', 'width', 'height'];

function fail(message) {
  throw new TypeError(message);
}

function plainRecord(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(`${name} must be an exact plain record`);
  }
  return value;
}

function exactKeys(value, fields, name) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    fail(`${name} contains unknown or missing fields`);
  }
}

function safeString(value, name, { nullable = false, maximum = 512 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${name} must be a bounded string`);
  }
  return value;
}

function safeUrl(value) {
  const url = safeString(value, 'frameUrl', { maximum: 2048 });
  try {
    new URL(url);
  } catch {
    fail('frameUrl must be a valid URL');
  }
  return url;
}

function safeNonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a nonnegative integer`);
  return value;
}

function safeNonnegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) fail(`${name} must be a nonnegative number`);
  return value;
}

function normalizeBounds(value) {
  const bounds = plainRecord(value, 'bounds');
  exactKeys(bounds, BOUNDS_FIELDS, 'bounds');
  return Object.freeze(Object.fromEntries(
    BOUNDS_FIELDS.map(field => [field, safeNonnegativeNumber(bounds[field], `bounds.${field}`)])
  ));
}

function normalizeRecord(value) {
  const record = plainRecord(value, 'surface');
  exactKeys(record, REQUIRED_FIELDS, 'surface');
  const frameId = safeString(record.frameId, 'frameId');
  const frameUrl = safeUrl(record.frameUrl);
  const originClass = safeString(record.originClass, 'originClass');
  if (!ORIGIN_CLASSES.has(originClass)) fail('originClass is unsupported');
  const surfaceType = safeString(record.surfaceType, 'surfaceType');
  if (!SURFACE_TYPES.has(surfaceType)) fail('surfaceType is unsupported');
  const selector = safeString(record.selector, 'selector', { nullable: true });
  const targetIdentity = safeString(record.targetIdentity, 'targetIdentity', { nullable: true });
  const observationMethod = safeString(record.observationMethod, 'observationMethod');
  if (typeof record.visible !== 'boolean' || typeof record.webglContext !== 'boolean' ||
      typeof record.supported !== 'boolean') {
    fail('visible, webglContext, and supported must be booleans');
  }
  const drawCalls = safeNonnegativeInteger(record.drawCalls, 'drawCalls');
  const domIndex = safeNonnegativeInteger(record.domIndex, 'domIndex');
  const depth = safeNonnegativeInteger(record.depth, 'depth');
  if (depth > SURFACE_LIMITS.maxDepth) fail('surface depth exceeds limit');
  return Object.freeze({
    frameId, frameUrl, originClass, surfaceType, selector, targetIdentity,
    observationMethod, bounds: normalizeBounds(record.bounds), visible: record.visible,
    webglContext: record.webglContext, drawCalls, supported: record.supported, domIndex, depth
  });
}

export function normalizeWebGlSurfaces(value) {
  if (!Array.isArray(value) || value.length > SURFACE_LIMITS.maxSurfaces) {
    fail('surfaces must be a bounded array');
  }
  const records = value.map(normalizeRecord);
  if (new Set(records.map(record => record.frameId)).size > SURFACE_LIMITS.maxFrames) {
    fail('surface frame count exceeds limit');
  }
  return Object.freeze(records);
}

function area(record) {
  return record.bounds.width * record.bounds.height;
}

function originRank(originClass) {
  return originClass === 'main' ? 0 : originClass === 'same-origin' ? 1 : 2;
}

function identity(record) {
  return record.targetIdentity ?? record.selector ?? '';
}

function compareSurfaces(left, right) {
  return right.area - left.area || right.record.drawCalls - left.record.drawCalls ||
    originRank(left.record.originClass) - originRank(right.record.originClass) ||
    left.record.depth - right.record.depth || left.record.frameId.localeCompare(right.record.frameId) ||
    left.record.domIndex - right.record.domIndex || identity(left.record).localeCompare(identity(right.record));
}

export function selectWebGlSurface(value) {
  return normalizeWebGlSurfaces(value)
    .filter(record => record.supported && record.visible && record.webglContext &&
      (record.surfaceType === 'html-canvas' || record.surfaceType === 'offscreen-transferred'))
    .map(record => ({ record, area: area(record) }))
    .sort(compareSurfaces)[0]?.record ?? null;
}

function uniqueWarnings(warnings) {
  return [...new Set(warnings)];
}

export function webGlSurfaceWarnings(value) {
  if (!Array.isArray(value)) fail('surfaces must be a bounded array');
  const warnings = [];
  const frameCount = new Set(value.filter(item => item && typeof item === 'object').map(item => item.frameId)).size;
  if (value.length > SURFACE_LIMITS.maxSurfaces) warnings.push('surface_limit_exceeded');
  if (frameCount > SURFACE_LIMITS.maxFrames) warnings.push('frame_limit_exceeded');
  if (value.some(item => item && typeof item === 'object' && item.depth > SURFACE_LIMITS.maxDepth)) {
    warnings.push('depth_limit_exceeded');
  }
  if (warnings.length) return uniqueWarnings(warnings);

  const surfaces = normalizeWebGlSurfaces(value);
  if (surfaces.some(record => record.originClass === 'cross-origin' || record.originClass === 'opaque' ||
      record.surfaceType === 'cross-origin-frame')) {
    warnings.push('unsupported_cross_origin_surface');
  }
  const hasTransferredVisibleCanvas = surfaces.some(record =>
    record.surfaceType === 'offscreen-transferred' && record.visible && record.webglContext);
  if (surfaces.some(record => record.surfaceType === 'worker-offscreen' && record.visible &&
      !hasTransferredVisibleCanvas)) {
    warnings.push('worker_offscreen_without_transferred_visible_canvas');
  }
  if (!selectWebGlSurface(surfaces)) warnings.push('no_supported_surface');
  return uniqueWarnings(warnings);
}
