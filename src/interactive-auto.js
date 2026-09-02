import { Buffer } from 'node:buffer';

export const PASSIVE_BLOCKED_ACTIONS = Object.freeze([
  'click', 'keyboard', 'pointer', 'form', 'wallet', 'permission',
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
    guided: Object.freeze({ enabled: false, allowedActions: Object.freeze([]) }),
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

export function assertPassiveAutomationAction(type) {
  if (!['observe', 'wait', 'capture'].includes(type)) {
    throw new TypeError(`Passive capture blocks ${type}`);
  }
  return true;
}

export function validateInteractiveAutoSettings(options = {}) {
  if (options.interactionMode !== undefined && options.interactionMode !== 'passive') {
    throw new TypeError('Only passive interactionMode is enabled');
  }
  const values = {
    interactionMode: 'passive',
    observationMs: options.observationMs ?? 10_000,
    sampleIntervalMs: options.sampleIntervalMs ?? 500,
    representativeMoments: options.representativeMoments ?? 4,
    stabilitySamples: options.stabilitySamples ?? 3,
    stabilityThreshold: options.stabilityThreshold ?? 0.015
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

function bytes(value) {
  if (typeof value !== 'string') throw new TypeError('Visual sample must be canonical base64');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new TypeError('Visual sample must be canonical base64');
  return result;
}

export function visualChangeScore(left, right) {
  if (left === right) return 0;
  const a = bytes(left);
  const b = bytes(right);
  if (!a.length && !b.length) return 0;
  const slots = Math.min(256, Math.max(a.length, b.length));
  let difference = 0;
  for (let index = 0; index < slots; index += 1) {
    const ai = a.length ? a[Math.min(a.length - 1, Math.floor(index * a.length / slots))] : 0;
    const bi = b.length ? b[Math.min(b.length - 1, Math.floor(index * b.length / slots))] : 0;
    difference += Math.abs(ai - bi) / 255;
  }
  const lengthDifference = Math.abs(a.length - b.length) / Math.max(1, a.length, b.length);
  return Number(Math.min(1, difference / slots * 0.8 + lengthDifference * 0.2).toFixed(6));
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

export const PAGE_WEBGL_RUNTIME_HOOK = `(() => {
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

export const PAGE_WEBGL_OBSERVATION_EXPRESSION = `(() => {
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

export async function observeInteractiveAuto(cdp, options) {
  const settings = validateInteractiveAutoSettings(options);
  const samples = [];
  const warnings = [];
  let sawVisibleCanvas = false;
  let sawWebGlContext = false;
  let renderFailure = false;
  let observationFailure;
  let aggregateBytes = 0;
  const totalSamples = Math.ceil(settings.observationMs / settings.sampleIntervalMs) + 1;
  for (let index = 0; index < totalSamples; index += 1) {
    options.active();
    try {
      const canvases = await options.bounded(
        cdp.evaluate(PAGE_WEBGL_OBSERVATION_EXPRESSION), options.checkpointMs
      );
      sawVisibleCanvas ||= Array.isArray(canvases) && canvases.some(item => item.visible);
      sawWebGlContext ||= Array.isArray(canvases) && canvases.some(item => item.webglContext);
      const targetCanvas = selectTargetCanvas(canvases);
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
    warnings.push(!sawVisibleCanvas ? 'no_visible_canvas' : !sawWebGlContext ? 'non_webgl_canvas' : 'webgl_inactive');
    return { screenshots: [], autoCapture: {
      interactionMode: 'passive', completionStatus: 'complete', warnings,
      observedSamples: 0, selectedMoments: 0, blockedActions: PASSIVE_BLOCKED_ACTIONS,
      automation: passiveAutomationProvenance(null, settings)
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
    warnings: [...warnings],
    blockedActions: [...PASSIVE_BLOCKED_ACTIONS],
    automation: passiveAutomationProvenance(sample, settings),
    completionStatus: renderFailure ? 'partial' : 'complete'
  }));
  return { screenshots, autoCapture: {
    interactionMode: 'passive',
    completionStatus: renderFailure ? 'partial' : 'complete',
    warnings, observedSamples: samples.length,
    selectedMoments: screenshots.length,
    targetCanvas: initial.targetCanvas,
    stabilityCriteria: screenshots[0].stabilityCriteria,
    blockedActions: PASSIVE_BLOCKED_ACTIONS
  } };
}
