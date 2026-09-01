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
  assert.equal((await response.json()).revision, 2);
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
