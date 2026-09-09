// Requires the pinned Visparse installation; deliberately fails if unavailable.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVisparseRunner } from '../src/visparse-runner.js';
import { AnalysisService } from '../src/analysis-service.js';
import { MemoryStore } from './fixtures/analysis-store.mjs';
import { png } from './fixtures/analysis-profile.mjs';

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
