import { validateCaptureSettings } from './chrome-capture.js';

export const CAPTURE_SETTING_KEYS = Object.freeze([
  'preset', 'mode', 'selector', 'width', 'height', 'checkpoints',
  'readinessMs', 'settleMs', 'maxRedirects'
]);

export function normalizeCaptureRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Capture request must be an object');
  const keys = Object.keys(value);
  if (keys.some(key => key !== 'referenceId' && key !== 'settings')) throw new TypeError('Capture request contains unsupported fields');
  if (typeof value.referenceId !== 'string' || !value.referenceId || value.referenceId.length > 128) throw new TypeError('referenceId is required');
  const supplied = value.settings ?? {};
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new TypeError('settings must be an object');
  if (Object.keys(supplied).some(key => !CAPTURE_SETTING_KEYS.includes(key))) throw new TypeError('settings contains unsupported fields');
  let settings;
  try { settings = validateCaptureSettings(supplied); }
  catch { throw new TypeError('Capture settings are invalid'); }
  return { referenceId: value.referenceId, settings };
}

export function publicCaptureResult(result) {
  const status = result?.status;
  if (status === 'queued' || status === 'capturing' || status === 'idle') return { status };
  if (status === 'skipped') {
    return { status, ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) };
  }
  if (status !== 'complete' && status !== 'partial' && status !== 'cancelled') {
    const allowed = new Set([
      'CAPTURE_BUSY', 'CAPTURE_QUEUE_FULL', 'CAPTURE_FAILED',
      'INVALID_REFERENCE', 'INVALID_SETTINGS'
    ]);
    return {
      status: status || 'failed',
      ...(allowed.has(result?.error) ? { code: result.error } : {})
    };
  }
  return {
    status,
    captured: Array.isArray(result.captured) ? result.captured.map(item => ({
      assetId: item.assetId,
      targetId: item.targetId,
      momentId: item.momentId
    })) : [],
    ...(status === 'cancelled' ? { code: 'CAPTURE_CANCELLED' } : {})
  };
}
