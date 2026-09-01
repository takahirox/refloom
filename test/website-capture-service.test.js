import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProject, createReference, createWorkspace, updateProject } from '../src/domain.js';
import { RevisionConflictError } from '../src/persistence-errors.js';
import { encodeBackup, referencedBlobIds } from '../src/storage.js';
import { captureReference } from '../src/website-capture-service.js';

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];

class MemoryRepository {
  constructor() {
    this.revision = 0;
    this.workspace = createWorkspace();
    this.media = new Map();
    this.limits = { mediaBytes: 25 * 1024 * 1024 };
  }

  async load() {
    return { revision: this.revision, workspace: structuredClone(this.workspace) };
  }

  async commit(expectedRevision, workspace, additions = []) {
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(expectedRevision, this.revision);
    }
    const nextMedia = new Map(this.media);
    for (const addition of additions) {
      const bytes = Buffer.from(addition.data, 'base64');
      if (bytes.length > this.limits.mediaBytes) throw new Error('media limit');
      nextMedia.set(addition.id, {
        data: addition.data,
        type: addition.type ?? '',
        name: addition.name ?? ''
      });
    }
    const retained = referencedBlobIds(workspace);
    for (const id of retained) if (!nextMedia.has(id)) throw new Error(`missing media ${id}`);
    for (const id of nextMedia.keys()) if (!retained.has(id)) nextMedia.delete(id);
    this.workspace = structuredClone(workspace);
    this.media = nextMedia;
    this.revision += 1;
    return this.load();
  }

  async exportBackup() {
    return encodeBackup(this.workspace, [...this.media].map(([id, value]) => ({ id, ...value })));
  }
}

async function fixture(sourceUrl = 'https://example.com/page') {
  const store = new MemoryRepository();
  let workspace = createProject(createWorkspace(), { id: 'project-1', title: 'Original' });
  workspace = createReference(workspace, { id: 'reference-1', projectId: 'project-1', sourceUrl });
  await store.commit(0, workspace);
  return store;
}

function screenshot(index = 0, count = 1) {
  return {
    png: Buffer.from(`png-${index}`).toString('base64'),
    originalUrl: 'https://example.com/page',
    finalUrl: 'https://www.example.com/final',
    title: 'Example page',
    domain: 'www.example.com',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    checkpoint: { index, y: index * 720, count },
    capturedAt: '2026-08-30T00:00:00.000Z',
    captureMethod: 'automated-browser',
    captureStrategy: 'deterministic-scroll'
  };
}

function dependencies(driver, values = ['media-1', 'asset-1', 'target-1', 'moment-1']) {
  let index = 0;
  return { resolver, captureWebsite: driver, randomUUID: () => values[index++] };
}

test('persists complete capture provenance, relationships, and backup bytes', async () => {
  const store = await fixture();
  const driver = async (_url, options) => {
    await options.onScreenshot(screenshot());
    return { screenshots: [{ y: 0 }], finalUrl: 'https://www.example.com/final' };
  };
  const result = await captureReference(store, 'reference-1', { checkpoints: 1, width: 1280, height: 720 }, dependencies(driver));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.captured, [{ mediaId: 'capture_media-1', assetId: 'asset_asset-1', targetId: 'target_target-1', momentId: 'moment_moment-1' }]);
  const { workspace } = await store.load();
  const asset = workspace.assets[0];
  const target = workspace.targets[0];
  const moment = workspace.moments[0];
  assert.equal(asset.referenceId, 'reference-1');
  assert.equal(asset.locator, 'blob:capture_media-1');
  assert.equal(target.assetId, asset.id);
  assert.equal(target.referenceId, 'reference-1');
  assert.equal(moment.targetId, target.id);
  assert.deepEqual(asset.provenance, {
    originalUrl: 'https://example.com/page', finalUrl: 'https://www.example.com/final',
    pageTitle: 'Example page', domain: 'www.example.com', capturedAt: '2026-08-30T00:00:00.000Z',
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    captureMethod: 'automated-browser', captureStrategy: 'deterministic-scroll',
    checkpointIndex: 0, checkpointY: 0, checkpointCount: 1
  });
  assert.deepEqual(moment.state, asset.provenance);
  const backup = JSON.parse(await store.exportBackup());
  assert.equal(backup.binaries[0].data, Buffer.from('png-0').toString('base64'));
  assert.equal(backup.binaries[0].type, 'image/png');
  assert.equal(backup.binaries[0].name, 'capture_media-1.png');
});

test('failure before the first callback leaves the reference unchanged', async () => {
  const store = await fixture();
  const before = await store.load();
  const result = await captureReference(store, 'reference-1', {}, dependencies(async () => { throw new Error('private detail'); }, []));
  assert.deepEqual(result, { status: 'failed', captured: [], error: 'CAPTURE_FAILED' });
  assert.deepEqual(await store.load(), before);
});

test('WebGL failure preserves the bounded diagnostic and persists zero checkpoints', async () => {
  const store = await fixture();
  const before = await store.load();
  let callbacks = 0;
  const driver = async (_url, options) => {
    assert.equal(typeof options.onScreenshot, 'function');
    const error = new Error('Website capture failed.');
    Object.defineProperty(error, 'captureDiagnosticCode', { value: 'WEBGL_UNAVAILABLE' });
    throw error;
  };
  const result = await captureReference(store, 'reference-1', {}, dependencies(driver, []));
  assert.deepEqual(result, {
    status: 'failed', captured: [], error: 'CAPTURE_FAILED', diagnostic: 'WEBGL_UNAVAILABLE'
  });
  assert.equal(callbacks, 0);
  assert.deepEqual(await store.load(), before);
});

test('page runtime failure preserves the bounded diagnostic and persists zero checkpoints', async () => {
  const store = await fixture();
  const before = await store.load();
  let callbacks = 0;
  const driver = async (_url, options) => {
    assert.equal(typeof options.onScreenshot, 'function');
    const error = new Error('Website capture failed.');
    Object.defineProperty(error, 'captureDiagnosticCode', { value: 'PAGE_RUNTIME_ERROR' });
    throw error;
  };
  const result = await captureReference(store, 'reference-1', {}, dependencies(driver, []));
  assert.deepEqual(result, {
    status: 'failed', captured: [], error: 'CAPTURE_FAILED', diagnostic: 'PAGE_RUNTIME_ERROR'
  });
  assert.equal(callbacks, 0);
  assert.deepEqual(await store.load(), before);
});

test('failure after the first callback keeps the committed checkpoint', async () => {
  const store = await fixture();
  const driver = async (_url, options) => {
    await options.onScreenshot(screenshot());
    throw new Error('second checkpoint failed');
  };
  const result = await captureReference(store, 'reference-1', {}, dependencies(driver));
  assert.equal(result.status, 'partial');
  assert.equal(result.error, 'CAPTURE_FAILED');
  assert.equal((await store.load()).workspace.assets.length, 1);
});

test('retries a revision race against fresh state without replacing a UI update', async () => {
  const store = await fixture();
  const originalCommit = store.commit.bind(store);
  let raced = false;
  store.commit = async (...args) => {
    if (!raced && args[2]?.length) {
      raced = true;
      const current = await store.load();
      await originalCommit(current.revision, updateProject(current.workspace, 'project-1', { title: 'UI update' }));
    }
    return originalCommit(...args);
  };
  const driver = async (_url, options) => { await options.onScreenshot(screenshot()); return {}; };
  const result = await captureReference(store, 'reference-1', {}, dependencies(driver));
  assert.equal(result.status, 'complete');
  const { workspace } = await store.load();
  assert.equal(workspace.projects[0].title, 'UI update');
  assert.equal(workspace.assets.length, 1);
});

test('rejects missing and non-public or non-URL references without invoking the driver', async () => {
  const store = await fixture('/private/file.png');
  let invoked = false;
  const dependency = dependencies(async () => { invoked = true; }, []);
  assert.deepEqual(await captureReference(store, 'missing', {}, dependency), { status: 'failed', captured: [], error: 'INVALID_REFERENCE' });
  assert.deepEqual(await captureReference(store, 'reference-1', {}, dependency), { status: 'failed', captured: [], error: 'INVALID_REFERENCE' });
  assert.equal(invoked, false);
  assert.equal((await store.load()).workspace.assets.length, 0);
});

test('protects the same reference from concurrent capture but permits it after release', async () => {
  const store = await fixture();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let started;
  const active = new Promise(resolve => { started = resolve; });
  const driver = async () => { started(); await waiting; return {}; };
  const first = captureReference(store, 'reference-1', {}, dependencies(driver, []));
  await active;
  assert.deepEqual(await captureReference(store, 'reference-1', {}, dependencies(async () => ({}), [])), {
    status: 'failed', captured: [], error: 'CAPTURE_BUSY'
  });
  release();
  assert.equal((await first).status, 'complete');
  assert.equal((await captureReference(store, 'reference-1', {}, dependencies(async () => ({}), []))).status, 'complete');
});

test('uses the driver settings bounds and preserves store media limits', async () => {
  const store = await fixture();
  let invoked = false;
  const invalid = await captureReference(store, 'reference-1', { checkpoints: 6 }, dependencies(async () => { invoked = true; }, []));
  assert.deepEqual(invalid, { status: 'failed', captured: [], error: 'INVALID_SETTINGS' });
  assert.equal(invoked, false);

  const limited = await fixture();
  limited.limits.mediaBytes = 1;
  const driver = async (_url, options) => { await options.onScreenshot(screenshot()); return {}; };
  const result = await captureReference(limited, 'reference-1', {}, dependencies(driver));
  assert.deepEqual(result, { status: 'failed', captured: [], error: 'CAPTURE_FAILED' });
  assert.equal((await limited.load()).workspace.assets.length, 0);
});

test('reports cancellation separately while retaining the saved Reference', async () => {
  const store = await fixture();
  const controller = new AbortController();
  const driver = async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    throw new Error('aborted');
  };
  const result = await captureReference(store, 'reference-1', {}, {
    ...dependencies(driver, []), signal: controller.signal
  });
  assert.deepEqual(result, {
    status: 'cancelled', captured: [], error: 'CAPTURE_CANCELLED'
  });
  assert.equal((await store.load()).workspace.references.length, 1);
});
