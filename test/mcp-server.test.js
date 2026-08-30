import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createBoard, createProject, createReference, createTarget, createWorkspace } from '../src/domain.js';
import { FileWorkspaceStore } from '../src/file-workspace-store.js';
import { createMcpServer } from '../mcp-server.mjs';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'refloom-mcp-'));
  const store = new FileWorkspaceStore({ directory });
  await store.initialize();
  let workspace = createProject(createWorkspace(), { id: 'project_one', title: 'Identity' });
  workspace = createReference(workspace, { id: 'reference_one', projectId: 'project_one', title: 'Opening titles' });
  workspace = createTarget(workspace, { id: 'target_one', referenceId: 'reference_one', kind: 'reference' });
  workspace = createBoard(workspace, { id: 'board_one', projectId: 'project_one', title: 'Direction' });
  await store.commit(0, workspace);
  return directory;
}

function client(directory) {
  const child = spawn(process.execPath, ['mcp-server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, REFLOOM_DATA_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let nextId = 1;
  let stdout = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const index = stdout.indexOf('\n');
      const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 3000);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
  });
  return { child, request };
}

test('stdio discovery, progressive reads, additive writes, media, errors, and revisions', async t => {
  const directory = await fixture();
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const mcp = client(directory);
  t.after(() => mcp.child.kill());

  const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'refloom');
  assert.equal(initialized.result.protocolVersion, '2025-06-18');

  const discovered = await mcp.request('tools/list');
  const names = discovered.result.tools.map(tool => tool.name);
  assert.ok(names.includes('search_references'));
  assert.ok(names.includes('search_selections'));
  assert.ok(names.includes('add_asset'));
  assert.ok(names.includes('add_selection_to_board'));
  assert.ok(!names.some(name => /delete|remove|reset|replace/.test(name)));
  assert.equal(discovered.result.tools.find(tool => tool.name === 'list_projects').annotations.readOnlyHint, true);
  assert.equal(discovered.result.tools.find(tool => tool.name === 'create_reference').annotations.destructiveHint, false);
  const captureTool = discovered.result.tools.find(tool => tool.name === 'request_website_capture');
  assert.equal(captureTool.annotations.readOnlyHint, false);
  assert.equal(captureTool.annotations.destructiveHint, false);
  assert.equal(captureTool.annotations.openWorldHint, true);
  assert.deepEqual(Object.keys(captureTool.inputSchema.properties), ['referenceId', 'settings']);

  const projects = await mcp.request('tools/call', { name: 'list_projects', arguments: {} });
  assert.deepEqual(projects.result.structuredContent.projects.map(item => item.id), ['project_one']);
  const detail = await mcp.request('tools/call', { name: 'get_project', arguments: { projectId: 'project_one' } });
  assert.equal(detail.result.structuredContent.counts.references, 1);
  const search = await mcp.request('tools/call', { name: 'search_references', arguments: { query: 'opening', limit: 1 } });
  assert.equal(search.result.structuredContent.references[0].id, 'reference_one');

  const reference = await mcp.request('tools/call', { name: 'create_reference', arguments: { projectId: 'project_one', title: 'Texture' } });
  assert.equal(reference.result.structuredContent.revision, 2);
  const enriched = await mcp.request('tools/call', { name: 'enrich_reference', arguments: { referenceId: reference.result.structuredContent.entity.id, notes: 'Use the grain', expectedRevision: 2 } });
  assert.equal(enriched.result.structuredContent.entity.notes, 'Use the grain');

  const bytes = Buffer.from('registered image');
  const asset = await mcp.request('tools/call', { name: 'add_asset', arguments: {
    referenceId: reference.result.structuredContent.entity.id, kind: 'image', mediaType: 'image/png',
    filename: 'grain.png', data: bytes.toString('base64'), provenance: { source: 'test' }, expectedRevision: 3
  } });
  assert.equal(asset.result.structuredContent.entity.provenance.source, 'test');

  const resources = await mcp.request('resources/list');
  assert.equal(resources.result.resources.length, 1);
  assert.equal(resources.result.resources[0].mimeType, 'image/png');
  const media = await mcp.request('resources/read', { uri: resources.result.resources[0].uri });
  assert.deepEqual(Buffer.from(media.result.contents[0].blob, 'base64'), bytes);
  assert.equal(media.result.contents[0]._meta.provenance.filename, 'grain.png');

  const arbitrary = await mcp.request('resources/read', { uri: 'file:///etc/passwd' });
  assert.equal(arbitrary.error.data.code, 'INVALID_RESOURCE_URI');
  const missing = await mcp.request('tools/call', { name: 'get_reference', arguments: { referenceId: 'missing' } });
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.error.code, 'NOT_FOUND');

  const stale = await mcp.request('tools/call', { name: 'create_target', arguments: {
    referenceId: reference.result.structuredContent.entity.id, kind: 'asset', assetId: asset.result.structuredContent.entity.id, expectedRevision: 3
  } });
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.error.code, 'REVISION_CONFLICT');

  const target = await mcp.request('tools/call', { name: 'create_target', arguments: {
    referenceId: reference.result.structuredContent.entity.id, kind: 'asset', assetId: asset.result.structuredContent.entity.id, expectedRevision: 4
  } });
  const selection = await mcp.request('tools/call', { name: 'create_selection', arguments: {
    projectId: 'project_one', targetId: target.result.structuredContent.entity.id, aspect: 'Texture', intent: 'Use restrained grain', expectedRevision: 5
  } });
  const foundSelection = await mcp.request('tools/call', { name: 'search_selections', arguments: { projectId: 'project_one', aspect: 'text', limit: 1 } });
  assert.equal(foundSelection.result.structuredContent.selections[0].id, selection.result.structuredContent.entity.id);
  const board = await mcp.request('tools/call', { name: 'add_selection_to_board', arguments: {
    boardId: 'board_one', selectionId: selection.result.structuredContent.entity.id, expectedRevision: 6
  } });
  assert.deepEqual(board.result.structuredContent.entity.selectionIds, [selection.result.structuredContent.entity.id]);
  const direction = await mcp.request('tools/call', { name: 'get_creative_direction', arguments: { boardId: 'board_one' } });
  assert.equal(direction.result.structuredContent.creativeDirection.selections.length, 1);
  const projectDirections = await mcp.request('tools/call', { name: 'get_creative_direction', arguments: { projectId: 'project_one' } });
  assert.equal(projectDirections.result.structuredContent.creativeDirections.length, 1);

  const invalidArguments = await mcp.request('tools/call', { name: 'list_projects', arguments: { unexpected: true } });
  assert.equal(invalidArguments.result.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('injected MCP capture returns structured results and bounded tool errors', async () => {
  const store = { initialize: async () => {}, load: async () => ({ revision: 0, workspace: createWorkspace() }) };
  let next = { status: 'partial', captured: [{ assetId: 'a', targetId: 't', momentId: 'm', mediaId: 'hidden' }] };
  const calls = [];
  const mcp = createMcpServer({ store, diagnostics: { write() {} }, captureReference: async (...args) => { calls.push(args); return next; } });
  const partial = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r', settings: { width: 800 } } } });
  assert.deepEqual(partial.structuredContent, { status: 'partial', captured: [{ assetId: 'a', targetId: 't', momentId: 'm' }] });
  assert.equal(calls[0][1], 'r');
  assert.equal(calls[0][2].width, 800);

  next = { status: 'failed', captured: [], error: 'CAPTURE_BUSY' };
  const busy = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r' } } });
  assert.equal(busy.isError, true);
  assert.equal(busy.structuredContent.error.code, 'CAPTURE_BUSY');

  const invalid = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r', settings: { chromePath: '/tmp/chrome' } } } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('two stdio servers cannot silently overwrite the same revision', async t => {
  const directory = await fixture();
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const first = client(directory);
  const second = client(directory);
  t.after(() => { first.child.kill(); second.child.kill(); });
  await Promise.all([first.request('initialize'), second.request('initialize')]);
  const calls = await Promise.all([
    first.request('tools/call', { name: 'create_reference', arguments: { projectId: 'project_one', title: 'A', expectedRevision: 1 } }),
    second.request('tools/call', { name: 'create_reference', arguments: { projectId: 'project_one', title: 'B', expectedRevision: 1 } })
  ]);
  assert.equal(calls.filter(item => item.result.isError).length, 1);
  assert.equal(calls.filter(item => !item.result.isError).length, 1);
  assert.equal(calls.find(item => item.result.isError).result.structuredContent.error.code, 'REVISION_CONFLICT');
});
