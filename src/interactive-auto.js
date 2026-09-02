import { Buffer } from 'node:buffer';
import { PERCEPTUAL_METRIC_VERSION, perceptualChangeScore } from './perceptual-image.js';
import { validateGuidedActions } from './guided-interaction.js';
import { runGuidedActions } from './guided-executor.js';
import { PAGE_WEBGL_RUNTIME_HOOK as EXPANDED_WEBGL_RUNTIME_HOOK } from './webgl-page-runtime.js';
import { PAGE_WEBGL_SURFACE_EXPRESSION } from './webgl-surface-expression.js';
import {
  normalizeWebGlSurfaces, selectWebGlSurface, webGlSurfaceWarnings
} from './webgl-surfaces.js';
import { inspectCdpSurfaceTargets } from './cdp-surface-targets.js';

export const PAGE_WEBGL_RUNTIME_HOOK = EXPANDED_WEBGL_RUNTIME_HOOK;
export const PAGE_WEBGL_OBSERVATION_EXPRESSION = PAGE_WEBGL_SURFACE_EXPRESSION;

export const PASSIVE_BLOCKED_ACTIONS = Object.freeze([
  'click', 'keyboard', 'pointer', 'form', 'wallet', 'permission',
  'upload', 'purchase', 'navigation'
]);

export const GUIDED_BLOCKED_ACTIONS = Object.freeze([
  'keyboard', 'pointer', 'form', 'wallet', 'permission',
  'upload', 'purchase', 'navigation'
]);

export const AUTO_ACTION_SCHEMA = Object.freeze({
  schemaVersion: 1,
  orderedFields: Object.freeze(['order', 'type', 'status', 'relativeTimestampMs', 'detail']),
  actionTypes: Object.freeze([
    'observe', 'wait', 'capture', 'click', 'keyboard', 'pointer', 'form',
    'wallet', 'permission', 'upload', 'purchase', 'navigation'
  ]),
  modes: Object.freeze({
    passive: Object.freeze({ enabled: true, allowedActions: Object.freeze(['observe', 'wait', 'capture']) }),
    guided: Object.freeze({ enabled: true, allowedActions: Object.freeze(['click', 'observe', 'wait', 'capture']) }),
    explore: Object.freeze({ enabled: false, allowedActions: Object.freeze([]) })
  })
});

export const PASSIVE_AUTOMATION_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  interactionMode: 'passive',
  actionSchema: AUTO_ACTION_SCHEMA,
  blockedActions: PASSIVE_BLOCKED_ACTIONS,
  actions: Object.freeze([
    Object.freeze({
      order: 0,
      type: 'observe',
      status: 'completed',
      relativeTimestampMs: 0,
      detail: Object.freeze({ passive: true })
    }),
    Object.freeze({
      order: 1,
      type: 'capture',
      status: 'completed',
      relativeTimestampMs: 0,
      detail: Object.freeze({})
    })
  ])
});

function passiveAutomationProvenance(sample, settings) {
  const relativeTimestampMs = sample?.relativeTimestampMs ?? 0;
  const selector = sample?.targetCanvas?.selector;
  return {
    ...PASSIVE_AUTOMATION_PROVENANCE,
    actions: [
      {
        order: 0,
        type: 'observe',
        status: 'completed',
        relativeTimestampMs: 0,
        detail: {
          passive: true,
          observationMs: settings.observationMs,
          sampleIntervalMs: settings.sampleIntervalMs
        }
      },
      {
        order: 1,
        type: 'wait',
        status: 'completed',
        relativeTimestampMs,
        detail: { bounded: true }
      },
      {
        order: 2,
        type: 'capture',
        status: 'completed',
        relativeTimestampMs,
        detail: selector ? { targetSelector: selector } : {}
      }
    ]
  };
}

function visualMetric(settings) {
  return {
    version: PERCEPTUAL_METRIC_VERSION,
    threshold: settings.stabilityThreshold,
    grid: 'max-16x16-ycbcr'
  };
}

export function assertPassiveAutomationAction(type) {
  if (!['observe', 'wait', 'capture'].includes(type)) {
    throw new TypeError(`Passive capture blocks ${type}`);
  }
  return true;
}

export function validateInteractiveAutoSettings(options = {}) {
  const interactionMode = options.interactionMode ?? 'passive';
  if (!['passive', 'guided'].includes(interactionMode) ||
      (interactionMode === 'passive' && options.guidedActions !== undefined)) {
    throw new TypeError('Invalid interactionMode');
  }
  const values = {
    interactionMode,
    observationMs: options.observationMs ?? 10_000,
    sampleIntervalMs: options.sampleIntervalMs ?? 500,
    representativeMoments: options.representativeMoments ?? 4,
    stabilitySamples: options.stabilitySamples ?? 3,
    stabilityThreshold: options.stabilityThreshold ?? 0.015,
    ...(interactionMode === 'guided' ? { guidedActions: validateGuidedActions(options.guidedActions ?? []) } : {})
  };
  for (const key of ['observationMs', 'sampleIntervalMs', 'representativeMoments', 'stabilitySamples']) {
    if (!Number.isSafeInteger(values[key])) throw new TypeError(`${key} must be an integer`);
  }
  if (values.observationMs < 1_000 || values.observationMs > 30_000 ||
      values.sampleIntervalMs < 100 || values.sampleIntervalMs > 2_000 ||
      values.representativeMoments < 3 || values.representativeMoments > 5 ||
      values.stabilitySamples < 2 || values.stabilitySamples > 8 ||
      !Number.isFinite(values.stabilityThreshold) || values.stabilityThreshold < 0 ||
      values.stabilityThreshold > 1 ||
      Math.ceil(values.observationMs / values.sampleIntervalMs) + 1 > 64) {
    throw new TypeError('Interactive Auto settings exceed bounded limits');
  }
  return values;
}

export function visualChangeScore(left, right) {
  return perceptualChangeScore(left, right);
}

export function selectTargetCanvas(canvases) {
  if (!Array.isArray(canvases)) return null;
  return canvases
    .filter(item => item?.visible === true && item.webglContext === true &&
      Number.isFinite(item.drawCalls) && item.drawCalls > 0 &&
      Number.isFinite(item.bounds?.width) && Number.isFinite(item.bounds?.height) &&
      item.bounds.width > 0 && item.bounds.height > 0)
    .sort((left, right) =>
      right.bounds.width * right.bounds.height - left.bounds.width * left.bounds.height ||
      right.drawCalls - left.drawCalls || left.domIndex - right.domIndex)[0] ?? null;
}

export function findStableInitial(samples, settings) {
  const required = settings.stabilitySamples;
  for (let end = required - 1; end < samples.length; end += 1) {
    const window = samples.slice(end - required + 1, end + 1);
    if (window.every((sample, index) => index === 0 || sample.changeScore <= settings.stabilityThreshold)) {
      return { ...window.at(-1), selectionReason: 'initial_stable' };
    }
  }
  return samples.length ? { ...samples[0], selectionReason: 'initial_stability_timeout' } : null;
}

export function selectRepresentativeMoments(samples, initial, count) {
  if (!initial) return [];
  const candidates = samples.filter(sample => sample.index > initial.index);
  const selected = [initial];
  const representatives = [];
  while (representatives.length < count && candidates.length) {
    let best;
    for (const candidate of candidates) {
      const score = Math.min(...selected.map(item => visualChangeScore(item.png, candidate.png)));
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && candidate.index < best.candidate.index)) {
        best = { candidate, score };
      }
    }
    if (!best) break;
    representatives.push({
      ...best.candidate,
      selectionReason: 'representative_visual_change',
      selectionScore: best.score
    });
    selected.push(best.candidate);
    candidates.splice(candidates.indexOf(best.candidate), 1);
  }
  return representatives.sort((left, right) => left.index - right.index);
}

const LEGACY_PAGE_WEBGL_RUNTIME_HOOK = `(() => {
  const state = { webGlContextFailure: false, contexts: [], drawCalls: 0 };
  Object.defineProperty(globalThis, Symbol.for('refloom.pageRuntimeDiagnostic'), { value: state });
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, ...args) {
    const normalized = String(type).toLowerCase();
    const isWebGl = normalized === 'webgl' || normalized === 'webgl2' || normalized === 'experimental-webgl';
    try {
      const context = Reflect.apply(original, this, [type, ...args]);
      if (isWebGl && context === null) state.webGlContextFailure = true;
      if (isWebGl && context && !state.contexts.some(item => item.context === context)) {
        const record = { canvas: this, context, type: normalized, drawCalls: 0 };
        state.contexts.push(record);
        for (const method of ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
          if (typeof context[method] !== 'function') continue;
          const operation = context[method].bind(context);
          try {
            context[method] = (...values) => {
              record.drawCalls += 1;
              state.drawCalls += 1;
              return operation(...values);
            };
          } catch { /* read-only implementations still expose context acquisition */ }
        }
      }
      return context;
    } catch (error) {
      if (isWebGl) state.webGlContextFailure = true;
      throw error;
    }
  };
})()`;

export const PAGE_RUNTIME_DIAGNOSTIC_EXPRESSION = `Boolean(
  globalThis[Symbol.for('refloom.pageRuntimeDiagnostic')]?.webGlContextFailure
)`;

const LEGACY_PAGE_WEBGL_OBSERVATION_EXPRESSION = `(() => {
  const state = globalThis[Symbol.for('refloom.pageRuntimeDiagnostic')];
  const contexts = state?.contexts || [];
  return [...document.querySelectorAll('canvas')].map((canvas, domIndex) => {
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    const context = contexts.find(item => item.canvas === canvas);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.right > 0 &&
      rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    const selector = canvas.id ? '#' + CSS.escape(canvas.id) : 'canvas:nth-of-type(' +
      ([...canvas.parentElement.children].filter(item => item.tagName === 'CANVAS').indexOf(canvas) + 1) + ')';
    return {
      domIndex, selector, visible, webglContext: Boolean(context),
      contextType: context?.type || null, drawCalls: context?.drawCalls || 0,
      bounds: {
        x: Math.max(0, rect.left + scrollX), y: Math.max(0, rect.top + scrollY),
        width: Math.max(0, Math.min(rect.width, innerWidth - Math.max(0, rect.left))),
        height: Math.max(0, Math.min(rect.height, innerHeight - Math.max(0, rect.top)))
      }
    };
  });
})()`;

function surfaceObservation(value) {
  const envelope = Array.isArray(value) ? {
    surfaces: value.map((item, domIndex) => ({
      frameId: 'main-frame', frameUrl: 'about:blank', originClass: 'main',
      surfaceType: 'html-canvas', selector: item.selector ?? `canvas:nth-of-type(${domIndex + 1})`,
      targetIdentity: item.selector ?? `canvas-${domIndex}`,
      observationMethod: 'legacy-main-runtime', bounds: item.bounds,
      visible: Boolean(item.visible), webglContext: Boolean(item.webglContext),
      drawCalls: Number.isSafeInteger(item.drawCalls) && item.drawCalls >= 0 ? item.drawCalls : 0,
      supported: Boolean(item.webglContext), domIndex: item.domIndex ?? domIndex, depth: 0,
      ...(item.contextType === undefined ? {} : { contextType: item.contextType })
    })),
    warnings: []
  } : value;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      !Array.isArray(envelope.surfaces) || !Array.isArray(envelope.warnings) ||
      envelope.warnings.some(warning => typeof warning !== 'string' || warning.length > 80)) {
    throw new TypeError('Invalid WebGL surface observation');
  }
  const surfaces = normalizeWebGlSurfaces(envelope.surfaces.map(surface => {
    if (!Object.hasOwn(surface, 'contextType')) return surface;
    const { contextType: _contextType, ...record } = surface;
    return record;
  }));
  return {
    surfaces,
    warnings: [...new Set([...envelope.warnings, ...webGlSurfaceWarnings(surfaces)])]
  };
}

export async function observeInteractiveAuto(cdp, options) {
  const settings = validateInteractiveAutoSettings(options);
  const samples = [];
  const warnings = [];
  let surfaceTargets;
  if (options.inspectSurfaceTargets === true) {
    surfaceTargets = await inspectCdpSurfaceTargets(cdp, {
      mainUrl: options.mainUrl,
      bounded: options.bounded
    });
    warnings.push(...surfaceTargets.warnings);
  }
  let guidedAutomation;
  if (settings.interactionMode === 'guided') {
    guidedAutomation = settings.guidedActions.length
      ? await runGuidedActions(settings.guidedActions, {
        cdp,
        now: options.now ?? Date.now,
        active: options.active,
        bounded: options.bounded,
        checkpointMs: options.checkpointMs
      })
      : Object.freeze({ schemaVersion: 1, interactionMode: 'guided', actions: Object.freeze([]), warnings: Object.freeze([]) });
    warnings.push(...guidedAutomation.warnings);
  }
  let sawVisibleCanvas = false;
  let sawWebGlContext = false;
  let discoveredSurfaces = [];
  let renderFailure = false;
  let observationFailure;
  let aggregateBytes = 0;
  const totalSamples = Math.ceil(settings.observationMs / settings.sampleIntervalMs) + 1;
  for (let index = 0; index < totalSamples; index += 1) {
    options.active();
    try {
      const observed = surfaceObservation(await options.bounded(
        cdp.evaluate(PAGE_WEBGL_OBSERVATION_EXPRESSION), options.checkpointMs
      ));
      discoveredSurfaces = observed.surfaces;
      for (const warning of observed.warnings) {
        if (warning !== 'no_supported_surface' && !warnings.includes(warning)) warnings.push(warning);
      }
      sawVisibleCanvas ||= observed.surfaces.some(item => item.visible);
      sawWebGlContext ||= observed.surfaces.some(item => item.webglContext);
      const targetCanvas = selectWebGlSurface(observed.surfaces);
      if (targetCanvas) {
        assertPassiveAutomationAction('capture');
        const clip = { ...targetCanvas.bounds, scale: 1 };
        const shot = await options.bounded(cdp.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: true, clip
        }), options.checkpointMs);
        const size = typeof shot.data === 'string' ? Buffer.byteLength(shot.data, 'base64') : Infinity;
        if (size > options.maxScreenshotBytes || Buffer.from(shot.data || '', 'base64').toString('base64') !== shot.data) {
          throw new Error('invalid screenshot');
        }
        aggregateBytes += size;
        if (aggregateBytes > options.maxObservationBytes) {
          warnings.push('observation_byte_limit');
          renderFailure = true;
          observationFailure = new Error('Interactive Auto observation byte limit exceeded');
          break;
        }
        samples.push({
          index, png: shot.data, targetCanvas,
          relativeTimestampMs: index * settings.sampleIntervalMs,
          changeScore: samples.length ? visualChangeScore(samples.at(-1).png, shot.data) : 0
        });
      }
      if (index + 1 < totalSamples) {
        await options.bounded(
          options.pause(settings.sampleIntervalMs),
          settings.sampleIntervalMs + 100
        );
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      renderFailure = true;
      observationFailure = error;
      warnings.push('observation_failure');
      break;
    }
  }
  if (!samples.length) {
    if (observationFailure) throw observationFailure;
    if (!warnings.some(warning => warning.startsWith('unsupported_') || warning.startsWith('worker_'))) {
      warnings.push(!sawVisibleCanvas ? 'no_visible_canvas' : !sawWebGlContext ? 'non_webgl_canvas' : 'webgl_inactive');
    }
    return { screenshots: [], autoCapture: {
      interactionMode: settings.interactionMode, completionStatus: 'complete', warnings,
      observedSamples: 0, selectedMoments: 0,
      blockedActions: settings.interactionMode === 'guided' ? GUIDED_BLOCKED_ACTIONS : PASSIVE_BLOCKED_ACTIONS,
      visualMetric: visualMetric(settings),
      automation: settings.interactionMode === 'guided'
        ? { ...guidedAutomation, actionSchema: AUTO_ACTION_SCHEMA, blockedActions: GUIDED_BLOCKED_ACTIONS }
        : passiveAutomationProvenance(null, settings),
      surfaceDiscovery: { surfaces: discoveredSurfaces, warnings: [...warnings] },
      ...(surfaceTargets ? { surfaceTargets } : {})
    } };
  }
  const initial = findStableInitial(samples, settings);
  if (initial.selectionReason === 'initial_stability_timeout') warnings.push('stability_timeout');
  const representativeCount = settings.representativeMoments - 1;
  const representatives = selectRepresentativeMoments(samples, initial, representativeCount);
  if (representatives.length < representativeCount) warnings.push('insufficient_visual_change');
  const screenshots = [
    { ...initial, selectionScore: initial.changeScore }, ...representatives
  ].map((sample, checkpointIndex, selected) => ({
    ...sample,
    checkpoint: { index: checkpointIndex, y: 0, count: selected.length },
    stabilityCriteria: {
      samples: settings.stabilitySamples,
      threshold: settings.stabilityThreshold,
      intervalMs: settings.sampleIntervalMs
    },
    visualMetric: visualMetric(settings),
    warnings: [...warnings],
    blockedActions: [...(settings.interactionMode === 'guided' ? GUIDED_BLOCKED_ACTIONS : PASSIVE_BLOCKED_ACTIONS)],
    automation: settings.interactionMode === 'guided'
      ? { ...guidedAutomation, actionSchema: AUTO_ACTION_SCHEMA, blockedActions: GUIDED_BLOCKED_ACTIONS }
      : passiveAutomationProvenance(sample, settings),
    ...(surfaceTargets ? { surfaceTargets } : {}),
    surfaceDiscovery: { surfaces: discoveredSurfaces, warnings: [...warnings] },
    completionStatus: renderFailure ? 'partial' : 'complete'
  }));
  return { screenshots, autoCapture: {
    interactionMode: settings.interactionMode,
    completionStatus: renderFailure ? 'partial' : 'complete',
    warnings, observedSamples: samples.length,
    selectedMoments: screenshots.length,
    targetCanvas: initial.targetCanvas,
    stabilityCriteria: screenshots[0].stabilityCriteria,
    visualMetric: visualMetric(settings),
    blockedActions: settings.interactionMode === 'guided' ? GUIDED_BLOCKED_ACTIONS : PASSIVE_BLOCKED_ACTIONS,
    ...(settings.interactionMode === 'guided' ? {
      automation: { ...guidedAutomation, actionSchema: AUTO_ACTION_SCHEMA, blockedActions: GUIDED_BLOCKED_ACTIONS }
    } : {}),
    ...(surfaceTargets ? { surfaceTargets } : {}),
    surfaceDiscovery: { surfaces: discoveredSurfaces, warnings: [...warnings] }
  } };
}
