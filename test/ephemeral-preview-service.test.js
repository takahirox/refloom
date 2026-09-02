import assert from 'node:assert/strict';
import test from 'node:test';
import { EphemeralPreviewService } from '../src/ephemeral-preview-service.js';

const png = value => Buffer.from(value).toString('base64');
const metadata = data => ({
  png: png(data), originalUrl: 'https://example.com/', finalUrl: 'https://example.com/final',
  viewport: { width: 390, height: 844, deviceScaleFactor: 1 }, preset: 'mobile',
  mode: 'viewport', region: { x: 0, y: 0, width: 390, height: 844 },
  scroll: { x: 0, y: 0 }, checkpoint: { index: 0, y: 0, count: 1 },
  capturedAt: '2026-09-02T00:00:00.000Z', captureMethod: 'automated-browser',
  captureStrategy: 'viewport'
});

test('returns opaque temporary media with reproducible provenance and no persistence dependency', async t => {
  const calls = [];
  const ids = ['capture-id', 'media-id'];
  const service = new EphemeralPreviewService({
    uuid: () => ids.shift(), now: () => 1_000,
    captureWebsite: async (url, options) => {
      calls.push({ url, options });
      await options.onScreenshot(metadata('image bytes'));
    }
  });
  t.after(() => service.close());
  const queued = service.request({
    url: 'http://localhost:5173/', urlPolicy: 'loopback',
    settings: { preset: 'mobile', mode: 'viewport' }
  });
  assert.deepEqual(queued, { captureId: 'capture-id', status: 'queued' });
  await service.wait('capture-id');
  const completed = service.status('capture-id');
  assert.equal(completed.status, 'complete');
  assert.equal(completed.resources[0].uri, 'refloom://preview/media-id');
  assert.equal(completed.resources[0].provenance.preset, 'mobile');
  assert.deepEqual(completed.resources[0].provenance.viewport, {
    width: 390, height: 844, deviceScaleFactor: 1
  });
  assert.equal(calls[0].url, 'http://localhost:5173/');
  assert.equal(calls[0].options.urlPolicy, 'loopback');
  assert.equal(calls[0].options.mode, 'viewport');
  const media = service.read('refloom://preview/media-id');
  assert.equal(Buffer.from(media.blob, 'base64').toString(), 'image bytes');
  assert.equal(media._meta.provenance.captureStrategy, 'viewport');
});

test('expires bytes on the TTL timer', async () => {
  let now = 2_000;
  let timer;
  const clock = {
    setTimeout(callback) { timer = callback; return 1; },
    clearTimeout() {}
  };
  const ids = ['capture', 'media'];
  const service = new EphemeralPreviewService({
    uuid: () => ids.shift(), now: () => now, clock, ttlMs: 100,
    captureWebsite: async (_url, options) => options.onScreenshot(metadata('x'))
  });
  service.request({ url: 'https://example.com/' });
  await service.wait('capture');
  assert.equal(service.status('capture').status, 'complete');
  now = 2_100;
  timer();
  assert.deepEqual(service.status('capture'), { status: 'idle' });
  assert.throws(() => service.read('refloom://preview/media'), {
    message: 'Temporary preview media is unavailable'
  });
  await service.close();
});

test('enforces aggregate resource count and byte caps with generic outcomes', async () => {
  const count = new EphemeralPreviewService({
    maxResources: 1, uuid: () => 'count',
    captureWebsite: async (_url, options) => {
      await options.onScreenshot(metadata('a'));
      await options.onScreenshot(metadata('b'));
    }
  });
  count.request({ url: 'https://example.com/', settings: { mode: 'scroll', checkpoints: 2 } });
  assert.deepEqual(await count.wait('count'), {
    captureId: 'count', status: 'failed', code: 'PREVIEW_CAPTURE_FAILED'
  });
  await count.close();

  const bytes = new EphemeralPreviewService({
    maxBytes: 2, maxResourceBytes: 10, uuid: () => 'bytes',
    captureWebsite: async (_url, options) => options.onScreenshot(metadata('abcd'))
  });
  bytes.request({ url: 'https://example.com/' });
  assert.deepEqual(await bytes.wait('bytes'), {
    captureId: 'bytes', status: 'failed', code: 'PREVIEW_CAPTURE_FAILED'
  });
  await bytes.close();
});

test('cancellation aborts work, publishes no media, and validates the narrow request shape', async () => {
  let observedSignal;
  const service = new EphemeralPreviewService({
    uuid: () => 'capture',
    captureWebsite: async (_url, options) => {
      observedSignal = options.signal;
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    }
  });
  const queued = service.request({ url: 'https://example.com/' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(service.cancel(queued.captureId), {
    captureId: 'capture', status: 'cancelled', code: 'PREVIEW_CAPTURE_CANCELLED'
  });
  await service.wait(queued.captureId);
  assert.equal(observedSignal.aborted, true);
  assert.equal(service.status(queued.captureId).status, 'cancelled');
  assert.throws(() => service.request({
    url: 'https://example.com/', settings: { executable: '/tmp/chrome' }
  }), { message: 'Preview capture request is invalid' });
  await service.close();
});
