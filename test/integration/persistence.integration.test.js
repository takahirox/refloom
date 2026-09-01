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
    sourceUrl: 'https://example.com', captureMethod: 'integration'
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
  assert.ok(tables.rows.some(row => row.table_name === 'media_objects'));
});
