// Portable attachment contract. Imported results remain untrusted derived data.
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
      || item.product !== ANALYSIS_PRODUCT || !hex(item.key)
      || !['running', 'complete', 'failed', 'cancelled'].includes(item.status)
      || !date(item.createdAt) || !date(item.updatedAt) || !date(item.expiresAt)
      || !item.input || !text(item.input.assetId) || !text(item.input.locator)
      || !hex(item.input.sha256) || item.input.sourceId !== 'reference-1'
      || !['preserve', 'adapt'].includes(item.intent)
      || !text(item.configuration) || !text(item.visparseVersion)
      || !workspace.assets.some(asset => asset.id === item.input.assetId && asset.referenceId === reference.id)
      || new TextEncoder().encode(JSON.stringify(item)).length > ANALYSIS_BYTES) throw new TypeError('Invalid analysis attachment');
    ids.add(item.id);
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
    stale: !asset || asset.locator !== item.input.locator,
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
