import { createAsset, createMoment, createTarget } from './domain.js';
import { RevisionConflictError } from './persistence-errors.js';
import {
  captureDiagnosticCode, captureWebsite, validateCaptureSettings
} from './chrome-capture.js';
import { normalizeCaptureUrl } from './capture-url.js';

const activeStores = new WeakMap();
const ERROR = Object.freeze({
  BUSY: 'CAPTURE_BUSY',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  FAILED: 'CAPTURE_FAILED'
});

const failed = (error, captured = [], diagnostic) => ({
  status: captured.length ? 'partial' : 'failed',
  captured,
  error,
  ...(diagnostic ? { diagnostic } : {})
});

function ids(randomUUID) {
  return {
    mediaId: `capture_${randomUUID()}`,
    assetId: `asset_${randomUUID()}`,
    targetId: `target_${randomUUID()}`,
    momentId: `moment_${randomUUID()}`
  };
}

function appendCheckpoint(workspace, referenceId, screenshot, entityIds) {
  const provenance = {
    originalUrl: screenshot.originalUrl,
    finalUrl: screenshot.finalUrl,
    pageTitle: screenshot.title,
    domain: screenshot.domain,
    capturedAt: screenshot.capturedAt,
    viewport: screenshot.viewport,
    captureMethod: screenshot.captureMethod,
    captureStrategy: screenshot.captureStrategy,
    checkpointIndex: screenshot.checkpoint.index,
    checkpointY: screenshot.checkpoint.y,
    checkpointCount: screenshot.checkpoint.count
  };
  let next = createAsset(workspace, {
    id: entityIds.assetId,
    referenceId,
    kind: 'image',
    locator: `blob:${entityIds.mediaId}`,
    mediaType: 'image/png',
    capturedAt: screenshot.capturedAt,
    provenance
  });
  next = createTarget(next, {
    id: entityIds.targetId,
    referenceId,
    assetId: entityIds.assetId,
    kind: 'frame',
    detail: { checkpointIndex: screenshot.checkpoint.index, y: screenshot.checkpoint.y }
  });
  return createMoment(next, {
    id: entityIds.momentId,
    targetId: entityIds.targetId,
    state: { ...provenance }
  });
}

export async function captureReference(store, referenceId, settings = {}, dependencies = {}) {
  const activeReferences = activeStores.get(store) || new Set();
  activeStores.set(store, activeReferences);
  if (activeReferences.has(referenceId)) return failed(ERROR.BUSY);
  activeReferences.add(referenceId);
  const captured = [];
  try {
    const initial = await store.load();
    const reference = initial.workspace.references.find(item => item.id === referenceId);
    if (!reference?.sourceUrl) return failed(ERROR.INVALID_REFERENCE);

    let source;
    try { validateCaptureSettings(settings); }
    catch { return failed(ERROR.INVALID_SETTINGS); }
    try { source = await normalizeCaptureUrl(reference.sourceUrl, { resolver: dependencies.resolver }); }
    catch { return failed(ERROR.INVALID_REFERENCE); }

    const driver = dependencies.captureWebsite || captureWebsite;
    const randomUUID = dependencies.randomUUID || (() => crypto.randomUUID());
    const retries = dependencies.revisionRetries ?? 2;
    const summary = await driver(source.href, {
      ...settings,
      ...(dependencies.captureOptions || {}),
      onScreenshot: async screenshot => {
        const entityIds = ids(randomUUID);
        for (let attempt = 0; ; attempt += 1) {
          const current = await store.load();
          if (!current.workspace.references.some(item => item.id === referenceId)) throw new Error(ERROR.FAILED);
          const next = appendCheckpoint(current.workspace, referenceId, screenshot, entityIds);
          try {
            await store.commit(current.revision, next, [{
              id: entityIds.mediaId,
              data: screenshot.png,
              type: 'image/png',
              name: `${entityIds.mediaId}.png`
            }]);
            captured.push(entityIds);
            return;
          } catch (error) {
            if (!(error instanceof RevisionConflictError) || attempt >= retries) throw error;
          }
        }
      }
    });
    return { status: 'complete', captured, summary };
  } catch (error) {
    return failed(ERROR.FAILED, captured, captureDiagnosticCode(error));
  } finally {
    activeReferences.delete(referenceId);
    if (!activeReferences.size) activeStores.delete(store);
  }
}
