import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisService } from '../src/analysis-service.js';
import { INSPECTION_PRODUCT, INTERACTION_PRODUCT, inspectionBundle, canonicalEvidence } from '../src/inspection-evidence.js';
import { createMoment, createTarget } from '../src/domain.js';
import { decodeBackup } from '../src/storage.js';
import { rowsToWorkspace, workspaceToRows } from '../src/postgres-workspace-mapper.js';
import { MemoryStore } from './fixtures/analysis-store.mjs';
import { capturedEvidence } from './fixtures/inspection-evidence.mjs';
import { digest } from '../src/visparse-runner.js';
import { png } from './fixtures/analysis-profile.mjs';

const request = { referenceId: 'r', assetId: 'a', product: INSPECTION_PRODUCT, momentId: 'm' };
const finish = service => Promise.all([...service.jobs.values()].map(j => j.promise));
function fixture(inspect) {
  const store = capturedEvidence(new MemoryStore());
  let calls = 0, preflights = 0;
  const runner = { enabled: true, configuration: 'design-config', inspectionConfiguration: 'inspection-config', timeoutMs: 10000,
    info: async () => { preflights++; return { version: 'fixture' }; },
    inspect: async (...args) => { calls++; return inspect ? inspect(...args) : { version: 'fixture', result: args[0] }; },
    analyze: () => assert.fail('Inspection must not call a model analyzer') };
  return { store, runner, service: new AnalysisService({ store, runner }), calls: () => calls, preflights: () => preflights };
}

test('inspection retains exact scoped evidence in the shared storage, backup and disabled retrieval lifecycle', async () => {
  const f = fixture();
  const job = await f.service.request(request); await finish(f.service);
  const item = await f.service.get('r', job.id);
  assert.equal(item.status, 'complete'); assert.equal(item.intent, 'inspect'); assert.equal(item.momentId, 'm');
  assert.deepEqual(item.result.captures.map(c => c.kind), ['screenshot', 'runtime', 'canvas', 'webgl']);
  assert.deepEqual(item.result.measurements, []); assert.deepEqual(item.result.interpretations, []);
  assert.deepEqual(item.result.captures[1].payload.metadata, f.store.workspace.moments[0].state);
  assert.equal(item.producer.agent, 'visparse.inspect_snapshot');
  assert.deepEqual(rowsToWorkspace(workspaceToRows(f.store.workspace)), f.store.workspace);
  assert.deepEqual(decodeBackup(await f.store.exportBackup()).workspace, f.store.workspace);
  f.runner.enabled = false;
  assert.equal((await new AnalysisService({ store: f.store, runner: f.runner }).get('r', job.id)).status, 'complete');
  assert.equal((await f.service.list('r')).items[0].result, undefined);
  assert.equal(f.calls(), 1);
});

test('deduplicated images use chosen Moment provenance; snapshot and product configuration govern reuse', async () => {
  const f = fixture();
  const a = await f.service.request(request); await finish(f.service);
  f.runner.configuration = 'new-model'; // irrelevant to deterministic inspection
  f.store.workspace.references[0].tags = ['tag'];
  assert.equal((await f.service.request(request)).id, a.id);
  const state = structuredClone(f.store.workspace.moments[0].state);
  state.capturedAt = '2026-09-02T00:00:00.000Z'; state.relativeTimestampMs = 200;
  f.store.workspace = createTarget(f.store.workspace, { id: 't2', referenceId: 'r', assetId: 'a', kind: 'frame' });
  f.store.workspace = createMoment(f.store.workspace, { id: 'm2', targetId: 't2', state });
  const b = await f.service.request({ ...request, momentId: 'm2' }); await finish(f.service);
  assert.notEqual(b.id, a.id);
  const item = await f.service.get('r', b.id);
  assert.equal(item.result.captures[1].payload.metadata.capturedAt, state.capturedAt);
  assert.notEqual(item.input.evidence.asset.provenance.capturedAt, state.capturedAt);
  f.store.workspace.moments[1].state.relativeTimestampMs = 250;
  assert.equal((await f.service.get('r', b.id)).stale, true);
  const c = await f.service.request({ ...request, momentId: 'm2' }); await finish(f.service);
  assert.notEqual(c.id, b.id);
  assert.equal(f.calls(), 3);
});

test('passive and guided evidence cannot become an interaction sequence; missing runtime and foreign scope fail before preflight', async () => {
  const f = fixture();
  for (const mode of ['passive', 'guided']) {
    f.store.workspace.moments[0].state.automation = { interactionMode: mode, actions: [{ type: 'click', outcome: 'executed' }] };
    await assert.rejects(f.service.request({ ...request, product: INTERACTION_PRODUCT }), { code: 'ANALYSIS_UNSUPPORTED_INTERACTION_EVIDENCE' });
  }
  await assert.rejects(f.service.request({ ...request, momentId: 'missing' }), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  f.store.workspace.targets[0].referenceId = 'other';
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  f.store.workspace.assets[0].provenance = {};
  await assert.rejects(f.service.request({ ...request, momentId: undefined }), { code: 'ANALYSIS_NO_RUNTIME_EVIDENCE' });
  assert.equal(f.calls(), 0); assert.equal(f.preflights(), 0);
});

test('mismatched digest and oversized provenance never reach Visparse', async () => {
  const f = fixture(); f.store.workspace.moments[0].state.screenshotSha256 = '0'.repeat(64);
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_STALE_INPUT' });
  delete f.store.workspace.moments[0].state.screenshotSha256;
  f.store.workspace.moments[0].state.extra = 'x'.repeat(300000);
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  assert.equal(f.preflights(), 0);
});

test('inspection treats screenshot bytes as an external artifact under the stored media limit', async () => {
  const f = fixture();
  const bytes = Buffer.alloc(1_000_001); png.copy(bytes);
  f.store.mediaInfo = async () => ({ contents: bytes, mediaType: 'image/png' });
  f.store.workspace.moments[0].state.screenshotSha256 = digest(bytes);
  const job = await f.service.request(request); await finish(f.service);
  assert.equal((await f.service.get('r', job.id)).status, 'complete');
  await assert.rejects(f.service.request({ referenceId: 'r', assetId: 'a' }), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1); png.copy(oversized);
  f.store.mediaInfo = async () => ({ contents: oversized, mediaType: 'image/png' });
  await assert.rejects(f.service.request(request), { code: 'ANALYSIS_UNSUPPORTED_EVIDENCE' });
  assert.equal(f.calls(), 1);
});

test('inspection never promotes unobserved signals or surface limitations into supported high-level captures', async () => {
  const f = fixture(); const state = f.store.workspace.moments[0].state;
  state.targetCanvas.supported = false;
  state.technology = 'Three.js'; state.dom = { invented: true };
  const job = await f.service.request(request); await finish(f.service);
  const item = await f.service.get('r', job.id);
  assert.deepEqual(item.result.captures.map(c => c.kind), ['screenshot', 'runtime', 'canvas']);
  assert.ok(!item.result.captures.some(c => ['dom', 'threejs', 'accessibility', 'css'].includes(c.kind)));
});

for (const mutation of ['identity', 'measurement', 'interpretation']) test(`modified inspection ${mutation} fails exact mapping validation`, async () => {
  const f = fixture(async bundle => {
    if (mutation === 'identity') bundle.captures[0].locator = 'file:sha256:' + '0'.repeat(64);
    if (mutation === 'measurement') bundle.measurements.push({ id: 'invented', value: 100 });
    if (mutation === 'interpretation') bundle.interpretations.push({ statement: 'Invented transition' });
    return { version: 'fixture', result: bundle };
  });
  const job = await f.service.request(request); await finish(f.service);
  assert.equal((await f.service.get('r', job.id)).code, 'ANALYSIS_INVALID_RESULT');
  assert.equal((await f.service.request(request)).id, job.id); assert.equal(f.calls(), 1);
});

for (const mutation of ['moment', 'target', 'cancel', 'restore']) test(`late inspection completion cannot undo ${mutation} change`, async () => {
  let resolve; const wait = new Promise(r => { resolve = r; });
  const f = fixture(async bundle => { await wait; return { version: 'fixture', result: bundle }; });
  const job = await f.service.request(request);
  if (mutation === 'moment') f.store.workspace.moments[0].state.relativeTimestampMs = 100;
  if (mutation === 'target') f.store.workspace.targets[0].detail.region = { x: 5 };
  if (mutation === 'cancel') await f.service.cancel('r', job.id);
  if (mutation === 'restore') await f.store.importBackup(f.store.revision, await f.store.exportBackup());
  resolve(); await finish(f.service);
  assert.notEqual((await f.service.get('r', job.id)).status, 'complete');
});

test('offline imported results cannot claim extra inspection evidence', async () => {
  const f = fixture(); const job = await f.service.request(request); await finish(f.service);
  const backup = JSON.parse(await f.store.exportBackup());
  const item = backup.workspace.references[0].analyses[0];
  assert.equal(canonicalEvidence(item.result), canonicalEvidence(inspectionBundle(item.input)));
  item.result.captures.push({ id: 'dom-1', kind: 'dom', locator: 'invented', payload: {} });
  assert.throws(() => decodeBackup(JSON.stringify(backup)));
});

test('inspection claims once across processes and shares concurrency with design analysis', async () => {
  let resolve; const wait = new Promise(r => { resolve = r; });
  const f = fixture(async bundle => { await wait; return { version: 'fixture', result: bundle }; });
  const other = new AnalysisService({ store: f.store, runner: f.runner });
  const [a, b] = await Promise.all([f.service.request(request), other.request({ ...request, force: true })]);
  assert.equal(a.id, b.id);
  await assert.rejects(other.request({ referenceId: 'r', assetId: 'a' }), { code: 'ANALYSIS_BUSY' });
  resolve(); await finish(f.service); await finish(other);
  assert.equal(f.calls(), 1);
  const forced = await other.request({ ...request, force: true }); await finish(other);
  assert.notEqual(forced.id, a.id); assert.equal(f.calls(), 2);
});
