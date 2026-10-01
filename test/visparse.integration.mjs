// Requires the pinned Visparse installation; deliberately fails if unavailable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVisparseRunner } from '../src/visparse-runner.js';
import { AnalysisService } from '../src/analysis-service.js';
import { MemoryStore } from './fixtures/analysis-store.mjs';
import { png } from './fixtures/analysis-profile.mjs';
import { capturedEvidence } from './fixtures/inspection-evidence.mjs';
import { INSPECTION_PRODUCT, inspectionBundle, inspectionSnapshot } from '../src/inspection-evidence.js';
import { digest } from '../src/visparse-runner.js';

const executable = fileURLToPath(new URL('./fixtures/analysis-agent.mjs', import.meta.url));
const environment = mode => ({ ...process.env, DATABASE_URL: 'must-not-reach-analyzer', REFLOOM_S3_SECRET_ACCESS_KEY: 'test-secret', REFLOOM_ANALYSIS_ENABLED: '1', REFLOOM_VISPARSE_AGENT: 'command', REFLOOM_VISPARSE_EXECUTABLE: executable, REFLOOM_VISPARSE_INHERIT_ENV: 'ANALYSIS_FIXTURE_MODE', ANALYSIS_FIXTURE_MODE: mode || '', REFLOOM_ANALYSIS_TIMEOUT_SECONDS: mode === 'timeout' ? '1' : '10' });

test('real Visparse command transport validates and persists a stored fixture through Refloom', async () => {
  const runner = createVisparseRunner(environment());
  const store = new MemoryStore(); const service = new AnalysisService({ store, runner });
  const job = await service.request({ referenceId: 'r', assetId: 'a' });
  await Promise.all([...service.jobs.values()].map(j => j.promise));
  const result = await service.get('r', job.id);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.result.schema_version, '0.3');
  assert.match(result.visparseVersion, /:[a-f0-9]{64}$/);
  assert.equal(result.producer.resolvedModel, null);
  assert.equal(JSON.stringify(result).includes('/private/'), false);
  assert.equal((await service.request({ referenceId: 'r', assetId: 'a' })).reused, true);
  await service.close();
});

for (const mode of ['identity', 'schema', 'measurement', 'failure', 'oversize', 'timeout']) test(`real Visparse rejects ${mode} without fallback`, async () => {
  const runner = createVisparseRunner(environment(mode));
  await assert.rejects(runner.analyze(png, 'preserve'), error => {
    assert.match(error.code, /^ANALYSIS_/); assert.equal(error.message.includes('private diagnostic'), false); return true;
  });
});

test('aborting the bridge terminates analysis', async () => {
  const runner = createVisparseRunner(environment('timeout'));
  const controller = new AbortController();
  const pending = runner.analyze(png, 'preserve', controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'ANALYSIS_CANCELLED' });
});

test('the maximum source size survives Base64 transport expansion', async () => {
  const runner = createVisparseRunner(environment());
  const image = Buffer.alloc(1_000_000); png.copy(image);
  const result = await runner.analyze(image, 'preserve');
  assert.equal(result.result.schema_version, '0.3');
  await assert.rejects(runner.analyze(Buffer.concat([image, Buffer.from([0])]), 'preserve'), { code: 'ANALYSIS_FAILED' });
});

test('real Visparse validates supplied runtime evidence durably without invoking the failing provider', async () => {
  // A provider invocation would fail this run. inspect_snapshot is deterministic.
  const runner = createVisparseRunner(environment('failure'));
  const store = capturedEvidence(new MemoryStore());
  const service = new AnalysisService({ store, runner });
  const job = await service.request({ referenceId: 'r', assetId: 'a', momentId: 'm', product: INSPECTION_PRODUCT });
  await Promise.all([...service.jobs.values()].map(j => j.promise));
  const item = await service.get('r', job.id);
  assert.equal(item.status, 'complete', JSON.stringify(item));
  assert.deepEqual(item.result.captures.map(c => c.kind), ['screenshot', 'runtime', 'canvas', 'webgl']);
  assert.equal(item.result.schema_version, '0.1');
  assert.deepEqual(item.result, inspectionBundle(item.input));
  assert.equal(item.settings.modelInvocation, false);
  await service.close();
});

for (const mode of ['schema', 'provenance', 'runtime-source', 'measurement', 'interpretation', 'string-limit']) test(`real inspection contract rejects ${mode}`, async () => {
  const runner = createVisparseRunner(environment('failure'));
  const store = capturedEvidence(new MemoryStore());
  const input = { assetId: 'a', locator: 'blob:b', sha256: digest(png),
    evidence: inspectionSnapshot(store.workspace.references[0], store.workspace.assets[0], store.workspace, 'm') };
  const bundle = inspectionBundle(input);
  if (mode === 'schema') bundle.schema_version = '99';
  if (mode === 'provenance') bundle.provenance.inputs = ['reference-1'];
  if (mode === 'runtime-source') bundle.runtime_observations = [{ id: 'obs', source_ids: ['reference-1'], statement: 'No runtime source.' }];
  if (mode === 'measurement') bundle.measurements = [{ id: 'measurement', source_id: 'invented', name: 'width', value: 10, method: 'invented' }];
  if (mode === 'interpretation') bundle.interpretations = [{ id: 'claim', evidence_ids: ['runtime-1'], statement: 'Raw captures cannot support inferred claims.', confidence_id: 'invented' }];
  if (mode === 'string-limit') bundle.captures[1].payload.extra = 'x'.repeat(100001);
  await assert.rejects(runner.inspect(bundle), { code: 'ANALYSIS_FAILED' });
});

test('inspection respects the actual Visparse JSON byte limit', async () => {
  const runner = createVisparseRunner(environment('failure'));
  const store = capturedEvidence(new MemoryStore());
  const bundle = inspectionBundle({ assetId: 'a', locator: 'blob:b', sha256: digest(png),
    evidence: inspectionSnapshot(store.workspace.references[0], store.workspace.assets[0], store.workspace) });
  bundle.captures[1].payload.extra = Array.from({ length: 11 }, () => 'x'.repeat(99999));
  await assert.rejects(runner.inspect(bundle), { code: 'ANALYSIS_FAILED' });
});

test('inspection requires no configured provider and preserves Unicode capture metadata', async () => {
  const runner = createVisparseRunner({ ...environment(), REFLOOM_VISPARSE_AGENT: 'unsupported-provider' });
  assert.equal(runner.enabled, false); assert.equal(runner.inspectionEnabled, true);
  const store = capturedEvidence(new MemoryStore());
  store.workspace.moments[0].state.pageTitle = '日本語のブラウザキャプチャ';
  const service = new AnalysisService({ store, runner });
  const job = await service.request({ referenceId: 'r', assetId: 'a', product: INSPECTION_PRODUCT, momentId: 'm' });
  await Promise.all([...service.jobs.values()].map(j => j.promise));
  const item = await service.get('r', job.id);
  assert.equal(item.status, 'complete', JSON.stringify(item));
  assert.equal(item.result.captures[1].payload.metadata.pageTitle, '日本語のブラウザキャプチャ');
  assert.deepEqual([ (await service.list('r')).enabled, (await service.list('r')).inspectionEnabled ], [false, true]);
  await assert.rejects(service.request({ referenceId: 'r', assetId: 'a' }), { code: 'ANALYSIS_UNAVAILABLE' });
  await service.close();
});
