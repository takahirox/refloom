// Collector-to-contract mapping only. Visparse owns inspection validation.
export const INSPECTION_PRODUCT = 'visparse.inspection';
export const INTERACTION_PRODUCT = 'visparse.interaction-profile';
export const INSPECTION_INPUT_BYTES = 1_000_000;
export const INSPECTION_SNAPSHOT_BYTES = 256 * 1024;
// External screenshot artifacts obey Refloom's existing media/capture limit;
// their bytes are not SourceEvidence inputs to a model analyzer.
export const INSPECTION_IMAGE_BYTES = 25 * 1024 * 1024;

export function canonicalEvidence(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

export function inspectionSnapshot(reference, asset, workspace, momentId) {
  const moment = momentId === undefined ? null : workspace.moments.find(m => m.id === momentId);
  const target = moment && workspace.targets.find(t => t.id === moment.targetId);
  if (momentId !== undefined && (!moment || !target || target.referenceId !== reference.id
    || target.assetId !== asset.id || target.projectId !== reference.projectId || moment.projectId !== reference.projectId)) {
    throw new TypeError('Moment does not belong to the selected evidence');
  }
  return structuredClone({
    reference: { id: reference.id, projectId: reference.projectId, createdAt: reference.createdAt,
      capturedAt: reference.capturedAt, captureMethod: reference.captureMethod, sourceUrl: reference.sourceUrl ?? null },
    asset: { id: asset.id, referenceId: asset.referenceId, projectId: asset.projectId,
      locator: asset.locator, kind: asset.kind, mediaType: asset.mediaType,
      capturedAt: asset.capturedAt, provenance: asset.provenance },
    target: target ?? null, moment: moment ?? null
  });
}

// No merge with Asset provenance: a deduplicated Asset can describe an earlier
// capture. The selected Moment is the authority for that capture's metadata.
export function inspectionBundle(input) {
  const snapshot = input.evidence;
  const metadata = snapshot.moment ? snapshot.moment.state : snapshot.asset.provenance;
  if (metadata?.captureMethod !== 'automated-browser' || !metadata.viewport
    || typeof metadata.capturedAt !== 'string') throw new TypeError('No stored runtime capture evidence');
  const identity = { referenceId: snapshot.reference.id, projectId: snapshot.reference.projectId,
    assetId: input.assetId, momentId: snapshot.moment?.id ?? null, targetId: snapshot.target?.id ?? null };
  const locator = `refloom://references/${identity.referenceId}/${identity.momentId ? `moments/${identity.momentId}` : `assets/${identity.assetId}`}`;
  const captures = [
    { id: 'reference-1', kind: 'screenshot', locator: `file:sha256:${input.sha256}`,
      payload: { ...identity, locator: input.locator, sha256: input.sha256, media_type: snapshot.asset.mediaType,
        provenance: snapshot.asset.provenance } },
    { id: 'runtime-1', kind: 'runtime', locator,
      payload: { ...identity, metadata, target: snapshot.target, moment: snapshot.moment,
        unavailable: ['dom', 'css', 'accessibility', 'threejs', 'interaction-sequence'] } }
  ];
  const surface = metadata.targetCanvas;
  if (surface && typeof surface === 'object' && !Array.isArray(surface)) {
    captures.push({ id: 'canvas-1', kind: 'canvas', locator: `${locator}/canvas`, payload: { ...identity, surface } });
    if (surface.webglContext === true && surface.supported === true) {
      captures.push({ id: 'webgl-1', kind: 'webgl', locator: `${locator}/webgl`, payload: { ...identity, surface } });
    }
  }
  // Preserve raw observations in payloads. Do not promote sampling schedules,
  // visual-change scores, or collector limits into exact behavioral measurements.
  return { schema_version: '0.1', captures, measurements: [], runtime_observations: [],
    visual_observations: [], interpretations: [], confidence: [],
    provenance: { created_by: 'refloom.inspection/1', inputs: captures.map(c => c.id) } };
}

export function inspectionStale(input, reference, workspace) {
  const asset = workspace.assets.find(a => a.id === input.assetId && a.referenceId === reference.id);
  if (!asset) return true;
  try { return canonicalEvidence(input.evidence) !== canonicalEvidence(inspectionSnapshot(reference, asset, workspace, input.evidence.moment?.id)); }
  catch { return true; }
}
