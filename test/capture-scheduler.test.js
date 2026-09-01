import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureScheduler } from '../src/capture-scheduler.js';

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('bounds global concurrency and queue length while reporting transitions', async () => {
  const operations = new Map();
  const started = [];
  const scheduler = new CaptureScheduler({
    store: {}, maxConcurrent: 1, maxQueue: 2,
    captureReference: async (_store, referenceId) => {
      started.push(referenceId);
      const operation = deferred();
      operations.set(referenceId, operation);
      return operation.promise;
    }
  });

  assert.deepEqual(scheduler.enqueue('a').outcome, { referenceId: 'a', status: 'queued' });
  await tick();
  assert.deepEqual(started, ['a']);
  assert.equal(scheduler.status('a').status, 'capturing');
  assert.equal(scheduler.enqueue('b').accepted, true);
  assert.equal(scheduler.enqueue('c').accepted, true);
  assert.deepEqual(scheduler.enqueue('d'), {
    accepted: false,
    outcome: { referenceId: 'd', status: 'failed', code: 'CAPTURE_QUEUE_FULL' }
  });
  assert.equal(scheduler.enqueue('b').outcome.code, 'CAPTURE_BUSY');

  operations.get('a').resolve({ status: 'complete', captured: [] });
  await scheduler.wait('a');
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  operations.get('b').resolve({ status: 'complete', captured: [] });
  await scheduler.wait('b');
  await tick();
  operations.get('c').resolve({ status: 'complete', captured: [] });
  await scheduler.wait('c');
  assert.equal(scheduler.status('c').status, 'complete');
});

test('cancels queued and running work and close drains active jobs', async () => {
  const scheduler = new CaptureScheduler({
    store: {}, maxConcurrent: 1, maxQueue: 2,
    captureReference: async (_store, _referenceId, _settings, dependencies) => {
      await new Promise(resolve => dependencies.signal.addEventListener('abort', resolve, { once: true }));
      return { status: 'cancelled', captured: [], error: 'CAPTURE_CANCELLED' };
    }
  });
  scheduler.enqueue('running');
  await tick();
  scheduler.enqueue('queued');
  assert.deepEqual(scheduler.cancel('queued'), { referenceId: 'queued', status: 'cancelled' });
  assert.equal((await scheduler.wait('queued')).status, 'cancelled');
  assert.deepEqual(scheduler.cancel('running'), { referenceId: 'running', status: 'cancelled' });
  assert.deepEqual(scheduler.status('running'), {
    referenceId: 'running', status: 'capturing', cancelRequested: true
  });
  await scheduler.close();
  assert.equal(scheduler.status('running').status, 'cancelled');
});
