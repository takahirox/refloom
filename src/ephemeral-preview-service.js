import { randomUUID } from 'node:crypto';
import { CAPTURE_SETTING_KEYS } from './capture-request.js';
import { captureWebsite as defaultCaptureWebsite, validateCaptureSettings } from './chrome-capture.js';

export const PREVIEW_MEDIA_URI = 'refloom://preview/';
export const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const ACTIVE = new Set(['queued', 'capturing']);

function positiveInteger(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError('Preview limits must be positive integers');
  return result;
}

function invalid() {
  throw new TypeError('Preview capture request is invalid');
}

function resourceError() {
  const error = new Error('Temporary preview media is unavailable');
  error.mcpCode = 'RESOURCE_NOT_FOUND';
  return error;
}

function publicResource(resource) {
  return {
    uri: resource.uri, name: resource.name, mimeType: resource.mimeType,
    expiresAt: resource.expiresAt, provenance: structuredClone(resource.provenance)
  };
}

function publicJob(job) {
  if (!job) return { status: 'idle' };
  const value = { captureId: job.id, status: job.status };
  if (job.status === 'complete') {
    value.expiresAt = job.expiresAt;
    value.resources = job.resourceIds.map(id => publicResource(job.owner.resources.get(id)));
  }
  if (job.status === 'failed') value.code = 'PREVIEW_CAPTURE_FAILED';
  if (job.status === 'cancelled') value.code = 'PREVIEW_CAPTURE_CANCELLED';
  return value;
}

export class EphemeralPreviewService {
  constructor(options = {}) {
    this.captureWebsite = options.captureWebsite ?? defaultCaptureWebsite;
    this.uuid = options.uuid ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? globalThis;
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_PREVIEW_TTL_MS);
    this.maxActiveJobs = positiveInteger(options.maxActiveJobs, 1);
    this.maxJobs = positiveInteger(options.maxJobs, 32);
    this.maxResources = positiveInteger(options.maxResources, 12);
    this.maxBytes = positiveInteger(options.maxBytes, 50 * 1024 * 1024);
    this.maxResourceBytes = positiveInteger(options.maxResourceBytes, 10 * 1024 * 1024);
    this.jobs = new Map();
    this.resources = new Map();
    this.usedBytes = 0;
    this.closed = false;
  }

  request(raw = {}) {
    this.cleanup();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
    if (Object.keys(raw).some(key => !['url', 'urlPolicy', 'settings'].includes(key))) invalid();
    if (typeof raw.url !== 'string' || !raw.url || raw.url.length > 2048) invalid();
    const urlPolicy = raw.urlPolicy ?? 'public';
    if (!['public', 'loopback'].includes(urlPolicy)) invalid();
    const supplied = raw.settings ?? {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) ||
        Object.keys(supplied).some(key => !CAPTURE_SETTING_KEYS.includes(key))) invalid();
    let settings;
    try { settings = validateCaptureSettings({ mode: 'viewport', ...supplied }); } catch { invalid(); }
    const active = [...this.jobs.values()].filter(job => ACTIVE.has(job.status)).length;
    if (this.closed || active >= this.maxActiveJobs || this.jobs.size >= this.maxJobs) {
      return { status: 'failed', code: 'PREVIEW_CAPTURE_FAILED' };
    }
    const job = {
      id: this.uuid(), owner: this, url: raw.url, urlPolicy, settings,
      status: 'queued', controller: new AbortController(), resourceIds: []
    };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    this.jobs.set(job.id, job);
    queueMicrotask(() => this.#run(job).then(job.resolve));
    return publicJob(job);
  }

  status(captureId) {
    this.cleanup();
    return publicJob(this.jobs.get(captureId));
  }

  wait(captureId) {
    return this.jobs.get(captureId)?.promise ?? Promise.resolve(this.status(captureId));
  }

  cancel(captureId) {
    this.cleanup();
    const job = this.jobs.get(captureId);
    if (!job || !ACTIVE.has(job.status)) return publicJob(job);
    job.controller.abort();
    job.status = 'cancelled';
    return publicJob(job);
  }

  read(uri) {
    this.cleanup();
    if (typeof uri !== 'string' || !uri.startsWith(PREVIEW_MEDIA_URI)) throw resourceError();
    const id = uri.slice(PREVIEW_MEDIA_URI.length);
    const resource = this.resources.get(id);
    if (!id || !resource || resource.uri !== uri) throw resourceError();
    return {
      uri, mimeType: resource.mimeType, blob: resource.bytes.toString('base64'),
      _meta: {
        captureId: resource.captureId, expiresAt: resource.expiresAt,
        provenance: structuredClone(resource.provenance)
      }
    };
  }

  cleanup() {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.expiresAtMs !== undefined && job.expiresAtMs <= now) this.#expire(id, job);
    }
  }

  async close() {
    this.closed = true;
    const pending = [];
    for (const job of this.jobs.values()) {
      if (ACTIVE.has(job.status)) {
        job.controller.abort();
        job.status = 'cancelled';
        pending.push(job.promise);
      }
    }
    await Promise.allSettled(pending);
    for (const job of this.jobs.values()) this.clock.clearTimeout?.(job.timer);
    this.jobs.clear();
    this.resources.clear();
    this.usedBytes = 0;
  }

  async #run(job) {
    const pending = [];
    try {
      if (job.controller.signal.aborted) throw new Error();
      job.status = 'capturing';
      await this.captureWebsite(job.url, {
        ...job.settings,
        urlPolicy: job.urlPolicy,
        signal: job.controller.signal,
        maxScreenshotBytes: this.maxResourceBytes,
        onScreenshot: async screenshot => {
          const bytes = Buffer.from(screenshot.png ?? '', 'base64');
          if (!screenshot.png || bytes.length > this.maxResourceBytes ||
              bytes.toString('base64') !== screenshot.png) throw new Error();
          pending.push({ bytes, provenance: {
            originalUrl: screenshot.originalUrl, finalUrl: screenshot.finalUrl,
            viewport: screenshot.viewport, preset: screenshot.preset, mode: screenshot.mode,
            region: screenshot.region, scroll: screenshot.scroll,
            checkpoint: screenshot.checkpoint, capturedAt: screenshot.capturedAt,
            captureMethod: screenshot.captureMethod, captureStrategy: screenshot.captureStrategy
          } });
        }
      });
      if (job.controller.signal.aborted) throw new Error();
      this.cleanup();
      const byteCount = pending.reduce((sum, item) => sum + item.bytes.length, 0);
      if (!pending.length || this.resources.size + pending.length > this.maxResources ||
          this.usedBytes + byteCount > this.maxBytes) throw new Error();
      const expiresAtMs = this.now() + this.ttlMs;
      const expiresAt = new Date(expiresAtMs).toISOString();
      pending.forEach((item, index) => {
        const id = this.uuid();
        const resource = {
          id, uri: `${PREVIEW_MEDIA_URI}${id}`, captureId: job.id,
          name: `implementation-preview-${index + 1}.png`, mimeType: 'image/png',
          bytes: item.bytes, expiresAt, provenance: item.provenance
        };
        this.resources.set(id, resource);
        this.usedBytes += item.bytes.length;
        job.resourceIds.push(id);
      });
      job.status = 'complete';
      this.#scheduleExpiry(job, expiresAtMs);
    } catch {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      this.#scheduleExpiry(job, this.now() + this.ttlMs);
    }
    return publicJob(job);
  }

  #scheduleExpiry(job, expiresAtMs) {
    job.expiresAtMs = expiresAtMs;
    job.expiresAt = new Date(expiresAtMs).toISOString();
    job.timer = this.clock.setTimeout(() => this.#expire(job.id, job), this.ttlMs);
  }

  #expire(id, job) {
    if (this.jobs.get(id) !== job) return;
    this.clock.clearTimeout?.(job.timer);
    for (const resourceId of job.resourceIds) {
      const resource = this.resources.get(resourceId);
      if (resource) this.usedBytes -= resource.bytes.length;
      this.resources.delete(resourceId);
    }
    this.jobs.delete(id);
  }
}
