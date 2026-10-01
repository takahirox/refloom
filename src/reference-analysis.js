// Portable attachment contract. Imported results remain untrusted derived data.
import { INSPECTION_PRODUCT, INSPECTION_SNAPSHOT_BYTES, canonicalEvidence, inspectionBundle, inspectionStale } from './inspection-evidence.js';
export const ANALYSIS_PRODUCT = 'visparse.design-profile';
export const ANALYSIS_LIMIT = 32;
export const ANALYSIS_BYTES = 1024 * 1024;
// Visparse SourceEvidence.MAX_INPUT_BYTES at the supported revision (decimal).
export const ANALYSIS_IMAGE_BYTES = 1_000_000;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateAnalyses(reference, workspace) {
  const items = reference.analyses;
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length > ANALYSIS_LIMIT) throw new TypeError('Invalid analysis attachments');
  const ids = new Set();
  for (const item of items) {
    if (!item || !text(item.id) || ids.has(item.id) || item.version !== 1
      || ![ANALYSIS_PRODUCT, INSPECTION_PRODUCT].includes(item.product) || !hex(item.key)
      || !['running', 'complete', 'failed', 'cancelled'].includes(item.status)
      || !date(item.createdAt) || !date(item.updatedAt) || !date(item.expiresAt)
      || !item.input || !text(item.input.assetId) || !text(item.input.locator)
      || !hex(item.input.sha256) || item.input.sourceId !== 'reference-1'
      || !(item.product === INSPECTION_PRODUCT ? item.intent === 'inspect' : ['preserve', 'adapt'].includes(item.intent))
      || !text(item.configuration) || !text(item.visparseVersion)
      || !workspace.assets.some(asset => asset.id === item.input.assetId && asset.referenceId === reference.id)
      || new TextEncoder().encode(JSON.stringify(item)).length > ANALYSIS_BYTES) throw new TypeError('Invalid analysis attachment');
    ids.add(item.id);
    if (item.product === INSPECTION_PRODUCT) {
      const e = item.input.evidence;
      if (new TextEncoder().encode(JSON.stringify(item.input)).length > INSPECTION_SNAPSHOT_BYTES
        || !hex(item.input.evidenceSha256) || !e || e.reference?.id !== reference.id
        || e.reference.projectId !== reference.projectId || e.asset?.id !== item.input.assetId
        || e.asset.referenceId !== reference.id || e.asset.projectId !== reference.projectId
        || e.asset.locator !== item.input.locator || e.asset.kind !== 'image'
        || !['image/png', 'image/jpeg'].includes(e.asset.mediaType)
        || (e.moment !== null && (!e.moment || !e.target || e.moment.targetId !== e.target.id
          || e.target.assetId !== e.asset.id || e.target.referenceId !== reference.id
          || e.target.projectId !== reference.projectId || e.moment.projectId !== reference.projectId))
        || (e.moment === null && e.target !== null)) throw new TypeError('Invalid inspection scope');
      const expected = inspectionBundle(item.input);
      if (item.status === 'complete' && canonicalEvidence(item.result) !== canonicalEvidence(expected)) throw new TypeError('Invalid inspection result identity');
      if (item.status !== 'complete' && item.result !== undefined) throw new TypeError('Only successful analyses have results');
      continue;
    }
    if (item.status === 'complete') {
      const p = item.result;
      if (!p || !['0.1', '0.2', '0.3'].includes(p.schema_version)
        || !Array.isArray(p.sources) || p.sources.length !== 1
        || p.sources[0].id !== item.input.sourceId || p.sources[0].role !== 'reference'
        || p.sources[0].locator !== `file:sha256:${item.input.sha256}`
        || p.sources[0].kind !== 'screenshot'
        || !['measurements', 'observations', 'interpretations', 'confidence'].every(k => Array.isArray(p[k]))) {
        throw new TypeError('Invalid analysis result identity or schema');
      }
    } else if (item.result !== undefined) throw new TypeError('Only successful analyses have results');
  }
}

export function analysisSummary(item, reference, workspace, now = Date.now()) {
  const asset = workspace.assets.find(a => a.id === item.input.assetId && a.referenceId === reference.id);
  const expired = item.status === 'running' && Date.parse(item.expiresAt) <= now;
  return {
    id: item.id, referenceId: reference.id, assetId: item.input.assetId,
    product: item.product, intent: item.intent,
    status: expired ? 'failed' : item.status,
    code: expired ? 'ANALYSIS_INTERRUPTED' : item.code,
    stale: item.product === INSPECTION_PRODUCT ? inspectionStale(item.input, reference, workspace) : !asset || asset.locator !== item.input.locator,
    ...(item.product === INSPECTION_PRODUCT ? { momentId: item.input.evidence.moment?.id ?? null } : {}),
    createdAt: item.createdAt, updatedAt: item.updatedAt,
    schemaVersion: item.result?.schema_version
  };
}

// Restoring a backup restores knowledge, never a right to complete an old job.
export function interruptRestoredAnalyses(workspace) {
  for (const ref of workspace.references) for (const item of ref.analyses ?? []) {
    if (item.status === 'running') {
      item.status = 'failed';
      item.code = 'ANALYSIS_INTERRUPTED';
    }
  }
  return workspace;
}
