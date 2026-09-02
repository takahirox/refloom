import { createHash } from 'node:crypto';
import { createAsset, createMoment, createTarget } from './domain.js';
import { RevisionConflictError } from './persistence-errors.js';
import {
  captureDiagnosticCode, captureWebsite, validateCaptureSettings
} from './chrome-capture.js';
import { normalizeCaptureUrl } from './capture-url.js';
import { blobIdFromLocator } from './storage.js';

const activeStores = new WeakMap();
const ERROR = Object.freeze({
  BUSY: 'CAPTURE_BUSY',
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  INVALID_SETTINGS: 'INVALID_SETTINGS',
  CANCELLED: 'CAPTURE_CANCELLED',
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

function appendCheckpoint(workspace, referenceId, screenshot, entityIds, reuseAsset = false) {
  const provenance = {
    sourceUrl: screenshot.sourceUrl || screenshot.originalUrl,
    originalUrl: screenshot.originalUrl,
    finalUrl: screenshot.finalUrl,
    pageTitle: screenshot.title,
    domain: screenshot.domain,
    capturedAt: screenshot.capturedAt,
    viewport: screenshot.viewport,
    preset: screenshot.preset,
    mode: screenshot.mode,
    captureMethod: screenshot.captureMethod,
    captureStrategy: screenshot.captureStrategy,
    screenshotSha256: screenshot.screenshotSha256,
    checkpointIndex: screenshot.checkpoint.index,
    checkpointY: screenshot.checkpoint.y,
    checkpointCount: screenshot.checkpoint.count,
    region: screenshot.region,
    scroll: screenshot.scroll,
    ...(screenshot.devicePixelRatio === undefined ? {} : { devicePixelRatio: screenshot.devicePixelRatio }),
    ...(screenshot.targetCanvas === undefined ? {} : { targetCanvas: screenshot.targetCanvas }),
    ...(screenshot.relativeTimestampMs === undefined ? {} : { relativeTimestampMs: screenshot.relativeTimestampMs }),
    ...(screenshot.stabilityCriteria === undefined ? {} : { stabilityCriteria: screenshot.stabilityCriteria }),
    ...(screenshot.selectionReason === undefined ? {} : { selectionReason: screenshot.selectionReason }),
    ...(screenshot.selectionScore === undefined ? {} : { selectionScore: screenshot.selectionScore }),
    ...(screenshot.visualMetric === undefined ? {} : { visualMetric: structuredClone(screenshot.visualMetric) }),
    ...(screenshot.warnings === undefined ? {} : { warnings: screenshot.warnings }),
    ...(screenshot.blockedActions === undefined ? {} : { blockedActions: screenshot.blockedActions }),
    ...(screenshot.completionStatus === undefined ? {} : { completionStatus: screenshot.completionStatus }),
    ...(screenshot.automation === undefined ? {} : { automation: screenshot.automation })
  };
  let next = workspace;
  if (!reuseAsset) {
    next = createAsset(next, {
      id: entityIds.assetId,
      referenceId,
      kind: 'image',
      locator: `blob:${entityIds.mediaId}`,
      mediaType: 'image/png',
      capturedAt: screenshot.capturedAt,
      provenance
    });
  }
  next = createTarget(next, {
    id: entityIds.targetId,
    referenceId,
    assetId: entityIds.assetId,
    kind: 'frame',
    detail: {
      checkpointIndex: screenshot.checkpoint.index,
      y: screenshot.checkpoint.y,
      mode: screenshot.mode,
      region: screenshot.region,
      scroll: screenshot.scroll
    }
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
  const assetsByDigest = new Map();
  try {
    const initial = await store.load();
    const reference = initial.workspace.references.find(item => item.id === referenceId);
    if (!reference?.sourceUrl) return failed(ERROR.INVALID_REFERENCE);
    for (const asset of initial.workspace.assets) {
      if (asset.referenceId !== referenceId ||
          typeof asset.provenance?.screenshotSha256 !== 'string') continue;
      const mediaId = blobIdFromLocator(asset.locator);
      if (mediaId) {
        assetsByDigest.set(asset.provenance.screenshotSha256, {
          assetId: asset.id,
          mediaId
        });
      }
    }

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
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      onScreenshot: async screenshot => {
        const screenshotSha256 = createHash('sha256')
          .update(Buffer.from(screenshot.png, 'base64')).digest('hex');
        const checkpoint = { ...screenshot, screenshotSha256 };
        const generatedIds = ids(randomUUID);
        const reused = assetsByDigest.get(screenshotSha256);
        const entityIds = reused ? {
          ...generatedIds,
          mediaId: reused.mediaId,
          assetId: reused.assetId
        } : generatedIds;
        for (let attempt = 0; ; attempt += 1) {
          const current = await store.load();
          if (!current.workspace.references.some(item => item.id === referenceId)) throw new Error(ERROR.FAILED);
          const reusable = Boolean(
            reused && current.workspace.assets.some(item => item.id === reused.assetId)
          );
          const next = appendCheckpoint(
            current.workspace, referenceId, checkpoint, entityIds, reusable
          );
          try {
            const additions = reusable ? [] : [{
              id: entityIds.mediaId,
              data: screenshot.png,
              type: 'image/png',
              name: `${entityIds.mediaId}.png`
            }];
            await store.commit(current.revision, next, additions);
            if (!reusable) assetsByDigest.set(screenshotSha256, entityIds);
            captured.push(entityIds);
            return;
          } catch (error) {
            if (!(error instanceof RevisionConflictError) || attempt >= retries) throw error;
          }
        }
      }
    });
    const completion = summary?.autoCapture?.completionStatus;
    return {
      status: completion === 'partial' ? 'partial' : 'complete',
      captured,
      summary,
      ...(completion === 'partial' ? { error: ERROR.FAILED } : {})
    };
  } catch (error) {
    if (dependencies.signal?.aborted) {
      return { status: 'cancelled', captured, error: ERROR.CANCELLED };
    }
    return failed(ERROR.FAILED, captured, captureDiagnosticCode(error));
  } finally {
    activeReferences.delete(referenceId);
    if (!activeReferences.size) activeStores.delete(store);
  }
}
