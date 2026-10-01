import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createMcpServer } from '../../mcp-server.mjs';
import { createRefloomServer } from '../../server.mjs';
import { createPersistenceRepository } from '../../src/create-persistence-repository.js';
import {
  createAsset, createBoard, createProject, createReference, createSelection,
  createTarget, createWorkspace
} from '../../src/domain.js';
import { RevisionConflictError } from '../../src/persistence-errors.js';
import { captureReference } from '../../src/website-capture-service.js';
import { AnalysisService } from '../../src/analysis-service.js';
import { digest } from '../../src/visparse-runner.js';
import { profile, png } from '../fixtures/analysis-profile.mjs';
import { readMigrations, runPostgresMigrations } from '../../src/postgres-migrations.js';
import pg from 'pg';

function repository() {
  return createPersistenceRepository({ env: process.env }).repository;
}

function errorChain(error) {
  const result = [];
  for (let current = error; current && result.length < 8; current = current.cause) {
    result.push({
      name: current.name,
      code: current.code,
      status: current.$metadata?.httpStatusCode
    });
  }
  return result;
}

function fixture() {
  let workspace = createProject(createWorkspace(), { id: 'project_1', title: 'Integration' });
  workspace = createReference(workspace, {
    id: 'reference_1', projectId: 'project_1', title: 'Source',
    sourceUrl: 'https://example.com', captureMethod: 'integration', tags: ['Visual Study', 'motion']
  });
  workspace = createAsset(workspace, {
    id: 'asset_1', referenceId: 'reference_1', kind: 'image',
    locator: 'blob:media_1', mediaType: 'text/plain'
  });
  workspace = createTarget(workspace, {
    id: 'target_1', referenceId: 'reference_1', assetId: 'asset_1', kind: 'asset'
  });
  workspace = createSelection(workspace, {
    id: 'selection_1', projectId: 'project_1', targetId: 'target_1',
    aspect: 'texture', intent: 'retain'
  });
  workspace = createBoard(workspace, {
    id: 'board_1', projectId: 'project_1', title: 'Direction',
    selectionIds: ['selection_1']
  });
  return workspace;
}

test('PostgreSQL and S3 are one authoritative path for repository, HTTP, and MCP', async t => {
  const writer = repository();
  try { await writer.initialize(); }
  catch (error) { assert.fail(`Initialization failed: ${JSON.stringify(errorChain(error))}`); }
  await writer.initialize();
  t.after(() => writer.close());

  const bytes = Buffer.from('integration-media');
  const committed = await writer.commit(0, fixture(), [{
    id: 'media_1', data: bytes, type: 'text/plain', name: 'integration.txt'
  }]);
  assert.equal(committed.revision, 1);
  assert.deepEqual(committed.workspace.boards[0].selectionIds, ['selection_1']);
  assert.deepEqual(committed.workspace.references[0].tags, ['visual-study', 'motion']);
  assert.deepEqual((await writer.mediaInfo('media_1')).contents, bytes);

  const stale = repository();
  await stale.initialize();
  t.after(() => stale.close());
  await assert.rejects(stale.commit(0, fixture()), RevisionConflictError);
  assert.equal((await stale.load()).revision, 1);

  const backup = await writer.exportBackup();
  const restored = await writer.importBackup(1, backup);
  assert.equal(restored.revision, 2);
  assert.deepEqual((await writer.mediaInfo('media_1')).contents, bytes);

  const mcpStore = repository();
  const mcp = createMcpServer({ store: mcpStore, diagnostics: { write() {} } });
  t.after(() => mcp.close());
  const projects = await mcp.handle({
    method: 'tools/call', params: { name: 'list_projects', arguments: {} }
  });
  assert.equal(projects.structuredContent.revision, 2);
  assert.deepEqual(projects.structuredContent.projects.map(item => item.id), ['project_1']);
  const resources = await mcp.handle({ method: 'resources/list' });
  const media = await mcp.handle({
    method: 'resources/read', params: { uri: resources.resources[0].uri }
  });
  assert.deepEqual(Buffer.from(media.contents[0].blob, 'base64'), bytes);

  const captureStore = repository();
  const captureMcp = createMcpServer({
    store: captureStore,
    diagnostics: { write() {} },
    captureReference: (store, referenceId, settings) => captureReference(
      store, referenceId, settings, {
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
        captureWebsite: async (sourceUrl, options) => {
          assert.equal(sourceUrl, 'https://example.com/');
          await options.onScreenshot({
            png: Buffer.from('captured-checkpoint').toString('base64'),
            originalUrl: sourceUrl,
            finalUrl: sourceUrl,
            title: 'Captured page',
            domain: 'example.com',
            capturedAt: '2026-09-01T00:00:00.000Z',
            viewport: { width: options.width, height: options.height, deviceScaleFactor: 1 },
            checkpoint: { index: 0, y: 0, count: 1 },
            captureMethod: 'automated-browser',
            captureStrategy: 'deterministic-scroll'
          });
          return { screenshots: [{}] };
        }
      }
    )
  });
  t.after(() => captureMcp.close());
  const captured = await captureMcp.handle({
    method: 'tools/call', params: { name: 'request_website_capture', arguments: {
      referenceId: 'reference_1', settings: { checkpoints: 1, width: 800, height: 600 }
    } }
  });
  assert.equal(captured.structuredContent.status, 'complete');
  assert.equal(captured.structuredContent.captured.length, 1);
  const capturedIds = captured.structuredContent.captured[0];
  const reference = await captureMcp.handle({
    method: 'tools/call', params: { name: 'get_reference', arguments: {
      referenceId: 'reference_1', limit: 100
    } }
  });
  assert.ok(reference.structuredContent.assets.some(item => item.id === capturedIds.assetId));
  assert.ok(reference.structuredContent.targets.some(item => item.id === capturedIds.targetId));
  assert.ok(reference.structuredContent.moments.some(item => item.id === capturedIds.momentId));
  const capturedAsset = reference.structuredContent.assets.find(item => item.id === capturedIds.assetId);
  const capturedMedia = await captureMcp.handle({
    method: 'resources/read', params: { uri: capturedAsset.resourceUri }
  });
  assert.deepEqual(Buffer.from(capturedMedia.contents[0].blob, 'base64'), Buffer.from('captured-checkpoint'));

  const automatic = await captureMcp.handle({
    method: 'tools/call', params: { name: 'create_reference', arguments: {
      projectId: 'project_1', title: 'Automatically captured',
      sourceUrl: 'https://example.com', expectedRevision: 3
    } }
  });
  assert.equal(automatic.structuredContent.capture.status, 'queued');
  const automaticId = automatic.structuredContent.entity.id;
  let automaticStatus;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    automaticStatus = await captureMcp.handle({
      method: 'tools/call', params: { name: 'get_capture_status', arguments: {
        referenceId: automaticId
      } }
    });
    if (!['queued', 'capturing'].includes(automaticStatus.structuredContent.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(automaticStatus.structuredContent.status, 'complete');
  const automaticReference = await captureMcp.handle({
    method: 'tools/call', params: { name: 'get_reference', arguments: {
      referenceId: automaticId, limit: 100
    } }
  });
  assert.equal(automaticReference.structuredContent.assets.length, 1);
  assert.equal(automaticReference.structuredContent.targets.length, 1);
  assert.equal(automaticReference.structuredContent.moments.length, 1);
  const automaticMedia = await captureMcp.handle({
    method: 'resources/read', params: {
      uri: automaticReference.structuredContent.assets[0].resourceUri
    }
  });
  assert.deepEqual(Buffer.from(automaticMedia.contents[0].blob, 'base64'), Buffer.from('captured-checkpoint'));

  const httpStore = repository();
  const server = createRefloomServer({ store: httpStore });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await server.initialization;
  t.after(async () => {
    server.close();
    await once(server, 'close');
    await server.repositoryClosed;
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  const response = await fetch(`${base}/api/workspace`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 5);
  assert.equal((await fetch(`${base}/api/workspace`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 1, workspace: fixture(), binaries: [] })
  })).status, 409);

  const tables = await writer.pool.query(
    "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
  );
  assert.ok(tables.rows.some(row => row.table_name === 'projects'));
  assert.ok(tables.rows.some(row => row.table_name === 'reference_tags'));
  assert.ok(tables.rows.some(row => row.table_name === 'media_objects'));
  const tags = await writer.pool.query(
    'select tag from reference_tags where reference_id = $1 order by position', ['reference_1']
  );
  assert.deepEqual(tags.rows.map(row => row.tag), ['visual-study', 'motion']);
});

test('stored analysis survives PostgreSQL reload and S3 backup; another process reuses it', async t => {
  const store = repository(); await store.initialize(); t.after(() => store.close());
  let workspace = createProject(createWorkspace(), { id: 'analysis_p', title: 'Analysis' });
  workspace = createReference(workspace, { id: 'analysis_r', projectId: 'analysis_p', captureMethod: 'website-capture' });
  workspace = createAsset(workspace, { id: 'analysis_a', referenceId: 'analysis_r', kind: 'image', mediaType: 'image/png', locator: 'blob:analysis_media', provenance: { captureMethod: 'automated-browser', mode: 'viewport', capturedAt: '2026-09-01T00:00:00.000Z', viewport: { width: 1280, height: 720 } } });
  await store.commit((await store.load()).revision, workspace, [{ id: 'analysis_media', data: png, type: 'image/png', name: 'capture.png' }]);
  let calls = 0, inspections = 0;
  const runner = { enabled: true, configuration: 'fixture', timeoutMs: 10000, info: async () => ({ version: 'fixture' }),
    analyze: async () => { calls++; return { version: 'fixture', result: profile(digest(png)) }; },
    inspect: async bundle => { inspections++; return { version: 'fixture', result: bundle }; } };
  const service = new AnalysisService({ store, runner }); t.after(() => service.close());
  const input = { referenceId: 'analysis_r', assetId: 'analysis_a' };
  const job = await service.request(input); await Promise.all([...service.jobs.values()].map(j => j.promise));
  assert.equal((await service.get(input.referenceId, job.id)).status, 'complete');
  const inspectionInput = { ...input, product: 'visparse.inspection' };
  const inspection = await service.request(inspectionInput); await Promise.all([...service.jobs.values()].map(j => j.promise));
  const inspectionResult = await service.get(input.referenceId, inspection.id);
  assert.equal(inspectionResult.status, 'complete');
  const backup = await store.exportBackup();
  const freshStore = repository(); await freshStore.initialize(); t.after(() => freshStore.close());
  const other = new AnalysisService({ store: freshStore, runner }); t.after(() => other.close());
  assert.equal((await other.request(input)).id, job.id); assert.equal(calls, 1);
  assert.equal((await other.request(inspectionInput)).id, inspection.id); assert.equal(inspections, 1);
  await store.commit((await store.load()).revision, createWorkspace());
  await assert.rejects(other.get(input.referenceId, job.id), { code: 'ANALYSIS_NOT_FOUND' });
  await store.importBackup((await store.load()).revision, backup);
  assert.deepEqual((await other.get(input.referenceId, job.id)).result, profile(digest(png)));
  assert.deepEqual((await other.get(input.referenceId, inspection.id)).result, inspectionResult.result);
  assert.deepEqual((await freshStore.mediaInfo('analysis_media')).contents, png);
});

test('0003 upgrades existing SQL rows without resetting references or revision', async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const connection = await pool.connect();
  const schema = `analysis_upgrade_${process.pid}`;
  await connection.query(`create schema ${schema}`);
  await connection.query(`set search_path to ${schema}`);
  t.after(async () => { await connection.query('set search_path to public'); await connection.query(`drop schema ${schema} cascade`); connection.release(); await pool.end(); });
  const scopedPool = { connect: async () => ({ query: (...args) => connection.query(...args), release() {} }) };
  const migrations = await readMigrations();
  await runPostgresMigrations(scopedPool, { migrations: migrations.slice(0, 2) });
  await connection.query("insert into projects (id,title,created_at,updated_at) values ('p','Existing',now(),now())");
  await connection.query(`insert into "references" (id,project_id,captured_at,capture_method,created_at,updated_at) values ('r','p',now(),'file',now(),now())`);
  await connection.query('update workspace_state set revision = 7');
  await runPostgresMigrations(scopedPool, { migrations });
  assert.deepEqual((await connection.query('select id, analyses from "references"')).rows, [{ id: 'r', analyses: [] }]);
  assert.equal(Number((await connection.query('select revision from workspace_state')).rows[0].revision), 7);
});
