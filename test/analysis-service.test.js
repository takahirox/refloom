import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisService } from '../src/analysis-service.js';
import { createAsset, createProject, createReference, createWorkspace, deleteReference, importWorkspace } from '../src/domain.js';
import { RevisionConflictError } from '../src/persistence-errors.js';
import { digest } from '../src/visparse-runner.js';
import { decodeBackup, encodeBackup } from '../src/storage.js';
import { rowsToWorkspace, workspaceToRows } from '../src/postgres-workspace-mapper.js';
import { profile, png } from './fixtures/analysis-profile.mjs';

import { MemoryStore } from './fixtures/analysis-store.mjs';

const request = { referenceId: 'r', assetId: 'a' };
function fixture(analyze) {
  const store = new MemoryStore();
  let calls = 0;
  const runner = { enabled: true, timeoutMs: 10000, configuration: 'fixture', producer: { agent: 'fixture', requestedModel: null, resolvedModel: null },
    info: async () => ({ version: 'test-1' }), analyze: async (...args) => { calls++; return analyze ? analyze(...args) : { version: 'test-1', result: profile(digest(png)) }; } };
  const service = new AnalysisService({ store, runner });
  return { store, runner, service, calls: () => calls };
}
async function finish(service) { await Promise.all([...service.jobs.values()].map(j => j.promise)); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('success is durable in relational mapping and backup; disabled reads do not analyze', async () => {
  const f = fixture();
  const job = await f.service.request(request); await finish(f.service);
  const success = await f.service.get('r', job.id);
  assert.equal(success.status, 'complete'); assert.equal(success.result.confidence[0].level, 0.5);
  assert.deepEqual(rowsToWorkspace(workspaceToRows(f.store.workspace)), f.store.workspace);
  const restored = decodeBackup(await f.store.exportBackup()).workspace;
  assert.deepEqual(restored, f.store.workspace);
  f.runner.enabled = false;
  const restarted = new AnalysisService({ store: f.store, runner: f.runner });
  assert.equal((await restarted.get('r', job.id)).status, 'complete');
  assert.equal((await restarted.list('r')).items[0].result, undefined);
  assert.equal(f.calls(), 1);
});

test('concurrent processes claim once and matching requests reuse; explicit force creates a new result', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise);
  const other = new AnalysisService({ store: f.store, runner: f.runner });
  const [a, b] = await Promise.all([f.service.request(request), other.request(request)]);
  assert.equal(a.id, b.id);
  wait.resolve({ version: 'test-1', result: profile(digest(png)) });
  await finish(f.service); await finish(other);
  assert.equal(f.calls(), 1);
  assert.equal((await other.request(request)).id, a.id);
  const fresh = await other.request({ ...request, force: true }); await finish(other);
  assert.notEqual(fresh.id, a.id); assert.equal(f.calls(), 2);
});

test('commit conflicts retry persistence without repeating analysis; tag changes do not invalidate', async () => {
  const f = fixture(async () => { f.store.conflicts = 2; return { version: 'test-1', result: profile(digest(png)) }; });
  const a = await f.service.request(request); await finish(f.service);
  f.store.workspace.references[0].tags = ['test']; f.store.revision++;
  assert.equal((await f.service.request(request)).id, a.id); assert.equal(f.calls(), 1);
});

test('changed configuration, intent and asset identity produce distinct keys', async () => {
  const f = fixture(); const ids = [];
  ids.push((await f.service.request(request)).id); await finish(f.service);
  ids.push((await f.service.request({ ...request, intent: 'adapt' })).id); await finish(f.service);
  f.runner.configuration = 'changed';
  ids.push((await f.service.request(request)).id); await finish(f.service);
  f.store.workspace.assets[0].locator = 'blob:c'; f.store.revision++;
  assert.equal((await f.service.get('r', ids[0])).stale, true);
  ids.push((await f.service.request(request)).id); await finish(f.service);
  assert.equal(new Set(ids).size, 4);
});

test('unsupported input and process-setting injection fail before model invocation', async () => {
  const f = fixture();
  await assert.rejects(f.service.request({ ...request, executable: '/bin/sh' }), { code: 'ANALYSIS_INVALID_REQUEST' });
  f.store.workspace.assets[0].kind = 'video';
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  assert.equal(f.calls(), 0);
});

test('images beyond the real Visparse limit are rejected before analyzer preflight', async () => {
  const f = fixture(); let preflights = 0;
  f.runner.info = async () => { preflights++; return { version: 'test-1' }; };
  const image = Buffer.alloc(1_000_001); png.copy(image);
  f.store.mediaInfo = async () => ({ contents: image, mediaType: 'image/png' });
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  assert.equal(preflights, 0); assert.equal(f.calls(), 0);
});

test('invalid identity is a failure and failed re-analysis preserves a prior result', async () => {
  const f = fixture(); const a = await f.service.request(request); await finish(f.service);
  f.runner.analyze = async () => ({ version: 'test-1', result: profile('0'.repeat(64)) });
  const b = await f.service.request({ ...request, force: true }); await finish(f.service);
  assert.equal((await f.service.get('r', b.id)).code, 'ANALYSIS_INVALID_RESULT');
  assert.equal((await f.service.get('r', a.id)).status, 'complete');
  assert.equal((await f.service.request(request)).id, b.id); // No implicit error retries.
});

for (const action of ['cancel', 'delete', 'restore', 'replace-input']) test(`late completion cannot undo ${action}`, async () => {
  const wait = deferred(); const entered = deferred();
  const f = fixture(() => { entered.resolve(); return wait.promise; });
  const job = await f.service.request(request); await entered.promise;
  if (action === 'cancel') await new AnalysisService({ store: f.store, runner: f.runner }).cancel('r', job.id);
  if (action === 'delete') await f.store.commit(f.store.revision, deleteReference(f.store.workspace, 'r'));
  if (action === 'restore') await f.store.importBackup(f.store.revision, await f.store.exportBackup());
  if (action === 'replace-input') { f.store.workspace.assets[0].locator = 'blob:changed'; f.store.revision++; }
  wait.resolve({ version: 'test-1', result: profile(digest(png)) }); await finish(f.service);
  if (action === 'delete') await assert.rejects(f.service.get('r', job.id), { code: 'ANALYSIS_NOT_FOUND' });
  else assert.notEqual((await f.service.get('r', job.id)).status, 'complete');
});

test('expired process leases become interrupted; bounded history and concurrency reject new work', async () => {
  const wait = deferred(); const f = fixture(() => wait.promise);
  const job = await f.service.request(request);
  await assert.rejects(f.service.request({ ...request, intent: 'adapt' }), { code: 'ANALYSIS_BUSY' });
  f.store.workspace.references[0].analyses[0].expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await f.service.get('r', job.id)).code, 'ANALYSIS_INTERRUPTED');
  const base = f.store.workspace.references[0].analyses[0];
  f.store.workspace.references[0].analyses = Array.from({ length: 32 }, (_, i) => ({ ...base, id: `id_${i}` }));
  await assert.rejects(f.service.request({ ...request, force: true }), { code: 'ANALYSIS_HISTORY_FULL' });
  wait.resolve({ version: 'test-1', result: profile(digest(png)) }); await finish(f.service);
});

test('backup v3 upgrades workspace v2 deterministically; older workspace writers are rejected', async () => {
  const store = new MemoryStore(); const text = JSON.parse(await store.exportBackup());
  text.version = 3; text.workspace.version = 2;
  const upgraded = decodeBackup(JSON.stringify(text));
  assert.deepEqual(upgraded.workspace, store.workspace);
  assert.throws(() => importWorkspace(text.workspace));
});
