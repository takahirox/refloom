import { Buffer } from 'node:buffer';
import { PAGE_WEBGL_SURFACE_EXPRESSION } from './webgl-surface-expression.js';
import { normalizeWebGlSurfaces } from './webgl-surfaces.js';

export const CDP_SURFACE_LIMITS = Object.freeze({
  maxTargets: 8,
  timeoutMs: 2_000,
  maxResponseBytes: 256 * 1024
});

const TARGET_TYPES = new Set(['iframe', 'worker', 'shared_worker']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function originClass(url, main) {
  if (url.origin === 'null') return 'opaque';
  return url.origin === main.origin ? 'same-origin' : 'cross-origin';
}

function safeTarget(value, main) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.targetId !== 'string' || value.targetId.length < 1 || value.targetId.length > 256 ||
      typeof value.type !== 'string' || !TARGET_TYPES.has(value.type) ||
      typeof value.url !== 'string' || value.url.length > 2_048) return null;
  let url;
  try { url = new URL(value.url || 'about:blank'); } catch { return null; }
  return { targetId: value.targetId, type: value.type, url: url.href, originClass: originClass(url, main) };
}

function safeEnvelope(response) {
  const value = response?.result?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Array.isArray(value.surfaces) || !Array.isArray(value.warnings)) {
    throw new TypeError('Invalid attached surface response');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > CDP_SURFACE_LIMITS.maxResponseBytes) {
    throw new RangeError('Attached surface response exceeds byte limit');
  }
  const surfaces = normalizeWebGlSurfaces(value.surfaces);
  const warnings = value.warnings.filter(item => typeof item === 'string' && item.length <= 80);
  if (warnings.length !== value.warnings.length) throw new TypeError('Invalid attached surface warnings');
  return { surfaces, warnings };
}

export async function inspectCdpSurfaceTargets(cdp, options) {
  if (!cdp || typeof cdp.send !== 'function' || !options ||
      typeof options.bounded !== 'function') throw new TypeError('Invalid CDP surface options');
  let main;
  try { main = new URL(options.mainUrl); } catch { throw new TypeError('Invalid CDP surface options'); }
  if (!['http:', 'https:'].includes(main.protocol)) throw new TypeError('Invalid CDP surface options');

  const warnings = [];
  const classifications = [];
  const attached = [];
  let response;
  try {
    response = await options.bounded(cdp.send('Target.getTargets'), CDP_SURFACE_LIMITS.timeoutMs);
  } catch {
    return deepFreeze({ classifications, attached, warnings: ['cdp_target_discovery_failed'] });
  }
  if (!Array.isArray(response?.targetInfos)) {
    return deepFreeze({ classifications, attached, warnings: ['cdp_target_discovery_invalid'] });
  }
  const candidates = response.targetInfos.map(item => safeTarget(item, main)).filter(Boolean)
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
  if (candidates.length > CDP_SURFACE_LIMITS.maxTargets) warnings.push('cdp_target_limit_exceeded');

  for (const target of candidates.slice(0, CDP_SURFACE_LIMITS.maxTargets)) {
    const attachable = target.type === 'iframe' && target.originClass === 'same-origin';
    const classification = { ...target, attached: false, observationMethod: attachable
      ? 'bounded-cdp-attachment-eligible' : 'target-classification' };
    classifications.push(classification);
    if (!attachable) {
      warnings.push(target.type === 'iframe' ? 'unsupported_cross_origin_oopif' : 'worker_surface_detected');
      continue;
    }
    let sessionId;
    try {
      const attachment = await options.bounded(cdp.send('Target.attachToTarget', {
        targetId: target.targetId, flatten: true
      }), CDP_SURFACE_LIMITS.timeoutMs);
      if (typeof attachment?.sessionId !== 'string' || !attachment.sessionId) throw new TypeError();
      sessionId = attachment.sessionId;
      classification.attached = true;
      classification.observationMethod = 'bounded-cdp-attachment';
      const evaluated = await options.bounded(cdp.send('Runtime.evaluate', {
        expression: PAGE_WEBGL_SURFACE_EXPRESSION, returnByValue: true, awaitPromise: true
      }, sessionId), CDP_SURFACE_LIMITS.timeoutMs);
      const envelope = safeEnvelope(evaluated);
      attached.push({ targetId: target.targetId, type: target.type, url: target.url,
        originClass: target.originClass, observationMethod: 'bounded-cdp-attachment', ...envelope });
    } catch (error) {
      warnings.push(error instanceof RangeError ? 'cdp_response_byte_limit' : 'cdp_attachment_failed');
    } finally {
      if (sessionId) {
        try {
          await options.bounded(cdp.send('Target.detachFromTarget', { sessionId }), CDP_SURFACE_LIMITS.timeoutMs);
        } catch { warnings.push('cdp_cleanup_failed'); }
      }
    }
  }
  return deepFreeze({ classifications, attached, warnings: [...new Set(warnings)] });
}
