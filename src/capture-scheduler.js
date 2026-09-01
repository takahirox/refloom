import { publicCaptureResult } from './capture-request.js';
import { captureReference as defaultCaptureReference } from './website-capture-service.js';

export const DEFAULT_CAPTURE_CONCURRENCY = 1;
export const DEFAULT_CAPTURE_QUEUE_LIMIT = 8;
const DEFAULT_HISTORY_LIMIT = 100;
const ACTIVE = new Set(['queued', 'capturing']);

function positiveInteger(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 100) {
    throw new TypeError(`${name} must be an integer from 1 to 100`);
  }
  return result;
}

function snapshot(job) {
  if (!job) return undefined;
  if (job.result) return { referenceId: job.referenceId, ...publicCaptureResult(job.result) };
  return {
    referenceId: job.referenceId,
    status: job.status,
    ...(job.cancelRequested ? { cancelRequested: true } : {})
  };
}

export class CaptureScheduler {
  constructor(options = {}) {
    if (!options.store) throw new TypeError('Capture scheduler requires a store');
    this.store = options.store;
    this.captureReference = options.captureReference ?? defaultCaptureReference;
    this.maxConcurrent = positiveInteger(
      options.maxConcurrent, DEFAULT_CAPTURE_CONCURRENCY, 'maxConcurrent'
    );
    this.maxQueue = positiveInteger(options.maxQueue, DEFAULT_CAPTURE_QUEUE_LIMIT, 'maxQueue');
    this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 'historyLimit');
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
  }

  enqueue(referenceId, settings = {}) {
    if (typeof referenceId !== 'string' || !referenceId || referenceId.length > 128) {
      throw new TypeError('referenceId is required');
    }
    const current = this.jobs.get(referenceId);
    if (current && ACTIVE.has(current.status)) {
      return { accepted: false, outcome: { referenceId, status: 'failed', code: 'CAPTURE_BUSY' } };
    }
    if (this.queue.length >= this.maxQueue) {
      return {
        accepted: false,
        outcome: { referenceId, status: 'failed', code: 'CAPTURE_QUEUE_FULL' }
      };
    }
    let resolve;
    const promise = new Promise(accept => { resolve = accept; });
    const job = {
      referenceId,
      settings: structuredClone(settings),
      status: 'queued',
      controller: new AbortController(),
      promise,
      resolve
    };
    this.jobs.delete(referenceId);
    this.jobs.set(referenceId, job);
    this.queue.push(job);
    queueMicrotask(() => this.#drain());
    this.#trimHistory();
    return { accepted: true, outcome: snapshot(job) };
  }

  status(referenceId) {
    return snapshot(this.jobs.get(referenceId))
      ?? { referenceId, status: 'idle' };
  }

  wait(referenceId) {
    return this.jobs.get(referenceId)?.promise;
  }

  async request(referenceId, settings = {}) {
    const scheduled = this.enqueue(referenceId, settings);
    if (!scheduled.accepted) {
      return { status: 'failed', captured: [], error: scheduled.outcome.code };
    }
    return this.wait(referenceId);
  }

  cancel(referenceId) {
    const job = this.jobs.get(referenceId);
    if (!job || !ACTIVE.has(job.status)) return this.status(referenceId);
    job.controller.abort();
    if (job.status === 'queued') {
      this.queue = this.queue.filter(item => item !== job);
      job.result = { status: 'cancelled', captured: [], error: 'CAPTURE_CANCELLED' };
      job.status = 'cancelled';
      job.resolve(job.result);
      this.#trimHistory();
    } else {
      job.cancelRequested = true;
    }
    return { referenceId, status: 'cancelled' };
  }

  async close() {
    const pending = [];
    for (const [referenceId, job] of this.jobs) {
      if (!ACTIVE.has(job.status)) continue;
      pending.push(job.promise);
      this.cancel(referenceId);
    }
    await Promise.allSettled(pending);
  }

  #drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (job.controller.signal.aborted) continue;
      job.status = 'capturing';
      this.active += 1;
      Promise.resolve().then(() => this.captureReference(
        this.store, job.referenceId, job.settings, { signal: job.controller.signal }
      )).catch(() => ({ status: 'failed', captured: [], error: 'CAPTURE_FAILED' }))
        .then(result => {
          job.result = result;
          job.status = result.status || 'failed';
          job.resolve(result);
        })
        .finally(() => {
          this.active -= 1;
          this.#trimHistory();
          this.#drain();
        });
    }
  }

  #trimHistory() {
    if (this.jobs.size <= this.historyLimit) return;
    for (const [referenceId, job] of this.jobs) {
      if (this.jobs.size <= this.historyLimit) break;
      if (!ACTIVE.has(job.status)) this.jobs.delete(referenceId);
    }
  }
}
