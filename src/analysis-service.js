import { randomUUID } from 'node:crypto';
import { analysisSummary, ANALYSIS_LIMIT, ANALYSIS_PRODUCT, validateAnalyses } from './reference-analysis.js';
import { createVisparseRunner, analysisError, digest } from './visparse-runner.js';
import { RevisionConflictError } from './persistence-errors.js';

const active = item => item.status === 'running' && Date.parse(item.expiresAt) > Date.now();
const refIn = (workspace, id) => {
  const ref = workspace.references.find(r => r.id === id);
  if (!ref) throw analysisError('ANALYSIS_NOT_FOUND');
  return ref;
};
export function normalizeAnalysisRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !['referenceId', 'assetId', 'intent', 'force'].includes(k))
    || ![value.referenceId, value.assetId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v))
    || (value.intent !== undefined && !['preserve', 'adapt'].includes(value.intent))
    || (value.force !== undefined && typeof value.force !== 'boolean')) throw analysisError('ANALYSIS_INVALID_REQUEST');
  return { ...value, intent: value.intent ?? 'preserve', force: value.force ?? false };
}

export class AnalysisService {
  constructor({ store, runner = createVisparseRunner(), concurrency = 1 } = {}) {
    this.store = store;
    this.runner = runner;
    this.concurrency = concurrency;
    this.jobs = new Map();
    this.closed = false;
    this.preparing = 0;
  }

  async change(operation) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.store.load();
      const result = operation(current.workspace);
      if (!result.write) return result.value;
      try {
        await this.store.commit(current.revision, current.workspace);
        return result.value;
      } catch (error) { if (!(error instanceof RevisionConflictError) || attempt === 4) throw error; }
    }
  }

  async list(referenceId, { offset = 0, limit = 20 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32) throw analysisError('ANALYSIS_INVALID_REQUEST');
    const { workspace } = await this.store.load();
    const reference = refIn(workspace, referenceId);
    const items = reference.analyses ?? [];
    return { enabled: this.runner.enabled, total: items.length, items: items.slice(offset, offset + limit).map(item => analysisSummary(item, reference, workspace)) };
  }

  async get(referenceId, analysisId) {
    const { workspace } = await this.store.load();
    const reference = refIn(workspace, referenceId);
    const item = reference.analyses?.find(a => a.id === analysisId);
    if (!item) throw analysisError('ANALYSIS_NOT_FOUND');
    return { ...structuredClone(item), ...analysisSummary(item, reference, workspace),
      compatibility: 'Compare input, intent, configuration and Visparse version before reuse',
      derived: true, input: item.input };
  }

  async request(raw) {
    if (this.preparing >= 4) throw analysisError('ANALYSIS_BUSY');
    this.preparing++;
    try { return await this.prepare(raw); }
    finally { this.preparing--; }
  }

  async prepare(raw) {
    const args = normalizeAnalysisRequest(raw);
    if (this.closed || !this.runner.enabled) throw analysisError('ANALYSIS_UNAVAILABLE');
    const { workspace } = await this.store.load();
    const reference = refIn(workspace, args.referenceId);
    const asset = workspace.assets.find(a => a.id === args.assetId && a.referenceId === reference.id);
    if (!asset || asset.kind !== 'image' || !['image/png', 'image/jpeg'].includes(asset.mediaType)
      || !/^blob:[A-Za-z0-9_-]{1,128}$/.test(asset.locator)) throw analysisError('ANALYSIS_UNSUPPORTED_EVIDENCE');
    const media = await this.store.mediaInfo(asset.locator.slice(5));
    const bytes = media.contents;
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (bytes.length > 8 * 1024 * 1024 || (asset.mediaType === 'image/png' ? !png : !jpeg)) throw analysisError('ANALYSIS_UNSUPPORTED_EVIDENCE');
    const info = await this.runner.info();
    if (typeof info.version !== 'string' || info.version.length > 256) throw analysisError('ANALYSIS_UNAVAILABLE');
    const input = { assetId: asset.id, locator: asset.locator, sha256: digest(bytes), sourceId: 'reference-1', role: 'reference', transform: 'none' };
    const key = digest(JSON.stringify({ referenceId: reference.id, input, intent: args.intent, configuration: this.runner.configuration, version: info.version }));
    const timestamp = new Date().toISOString();
    const job = { id: `analysis_${randomUUID()}`, version: 1, product: ANALYSIS_PRODUCT, key, input,
      intent: args.intent, configuration: this.runner.configuration, visparseVersion: info.version,
      producer: this.runner.producer, settings: this.runner.settings ?? {}, status: 'running', createdAt: timestamp, updatedAt: timestamp,
      expiresAt: new Date(Date.now() + this.runner.timeoutMs + 15000).toISOString() };
    const selected = await this.change(current => {
      if (this.closed) throw analysisError('ANALYSIS_UNAVAILABLE');
      const ref = refIn(current, reference.id);
      if (ref.createdAt !== reference.createdAt || ref.projectId !== reference.projectId
        || !current.assets.some(a => a.id === asset.id && a.referenceId === ref.id && a.locator === input.locator && a.kind === asset.kind && a.mediaType === asset.mediaType)) throw analysisError('ANALYSIS_STALE_INPUT');
      const entries = ref.analyses ?? [];
      const matching = [...entries].reverse().find(a => a.key === key && (active(a) || !args.force));
      if (matching) return { value: { id: matching.id, reused: true } };
      if (entries.length >= ANALYSIS_LIMIT) throw analysisError('ANALYSIS_HISTORY_FULL');
      if (current.references.flatMap(r => r.analyses ?? []).filter(active).length >= this.concurrency) throw analysisError('ANALYSIS_BUSY');
      ref.analyses = [...entries, job];
      return { write: true, value: { id: job.id, reused: false } };
    });
    if (!selected.reused) {
      const controller = new AbortController();
      const promise = this.execute(reference.id, job, bytes, controller).finally(() => this.jobs.delete(job.id));
      this.jobs.set(job.id, { controller, promise });
      promise.catch(() => {});
    }
    return { ...await this.get(reference.id, selected.id), reused: selected.reused, result: undefined };
  }

  async execute(referenceId, job, bytes, controller) {
    let checking = false;
    const check = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const item = await this.get(referenceId, job.id);
        if (item.status !== 'running' || item.key !== job.key || item.stale) controller.abort();
      } catch { controller.abort(); }
      finally { checking = false; }
    }, 1000);
    let outcome;
    try {
      const current = await this.get(referenceId, job.id);
      if (current.status !== 'running' || current.key !== job.key || current.stale) controller.abort();
      if (controller.signal.aborted) throw analysisError('ANALYSIS_CANCELLED');
      const result = await this.runner.analyze(bytes, job.intent, controller.signal);
      if (controller.signal.aborted) throw analysisError('ANALYSIS_CANCELLED');
      if (result.version !== job.visparseVersion) throw analysisError('ANALYSIS_INCOMPATIBLE');
      outcome = { status: 'complete', result: result.result };
    } catch (error) {
      outcome = { status: controller.signal.aborted ? 'cancelled' : 'failed',
        code: /^ANALYSIS_[A-Z_]+$/.test(error.code) ? error.code : 'ANALYSIS_FAILED' };
    } finally { clearInterval(check); }
    try {
      await this.change(workspace => {
        const ref = workspace.references.find(r => r.id === referenceId);
        const existing = ref?.analyses?.find(a => a.id === job.id && a.key === job.key);
        if (!existing || !active(existing)) return { value: false };
        const asset = workspace.assets.find(a => a.id === job.input.assetId && a.referenceId === referenceId);
        const next = !asset || asset.locator !== job.input.locator
          ? { status: 'failed', code: 'ANALYSIS_STALE_INPUT' } : outcome;
        Object.assign(existing, next, { updatedAt: new Date().toISOString() });
        try { validateAnalyses(ref, workspace); }
        catch { delete existing.result; existing.status = 'failed'; existing.code = 'ANALYSIS_INVALID_RESULT'; }
        return { write: true, value: true };
      });
    } catch { /* Lease expiry reports interrupted work if persistence remains unavailable. */ }
  }

  async cancel(referenceId, analysisId) {
    await this.change(workspace => {
      const ref = refIn(workspace, referenceId);
      const item = ref.analyses?.find(a => a.id === analysisId);
      if (!item) throw analysisError('ANALYSIS_NOT_FOUND');
      if (!active(item)) return { value: false };
      item.status = 'cancelled'; item.code = 'ANALYSIS_CANCELLED'; item.updatedAt = new Date().toISOString();
      return { write: true, value: true };
    });
    this.jobs.get(analysisId)?.controller.abort();
    return this.get(referenceId, analysisId);
  }

  async close() {
    this.closed = true;
    for (const { controller } of this.jobs.values()) controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(j => j.promise));
  }
}
