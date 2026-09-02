import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createBoard, createProject, createReference, createTarget, createWorkspace,
  updateWorkspaceSettings
} from '../src/domain.js';
import { PersistenceError, RevisionConflictError } from '../src/persistence-errors.js';
import { createMcpServer, runStdio } from '../mcp-server.mjs';

class MemoryRepository {
  constructor(workspace = createWorkspace()) {
    this.workspace = structuredClone(workspace);
    this.revision = 1;
    this.media = new Map();
    this.calls = [];
  }
  async initialize() { this.calls.push('initialize'); }
  async readiness() { this.calls.push('readiness'); return true; }
  async load() { return { revision: this.revision, workspace: structuredClone(this.workspace) }; }
  async commit(expected, workspace, additions = []) {
    if (expected !== this.revision) throw new RevisionConflictError(expected, this.revision);
    this.workspace = structuredClone(workspace);
    for (const addition of additions) this.media.set(addition.id, Buffer.from(addition.data, 'base64'));
    this.revision += 1;
    return this.load();
  }
  async mediaInfo(id) {
    const contents = this.media.get(id);
    if (!contents) throw new PersistenceError('Media is missing', { code: 'PERSISTENCE_NOT_FOUND', details: { id } });
    return { mediaType: 'image/png', contents };
  }
  async close() { this.calls.push('close'); }
}

function fixture() {
  let workspace = createProject(createWorkspace(), { id: 'project_one', title: 'Identity' });
  workspace = createReference(workspace, { id: 'reference_one', projectId: 'project_one', title: 'Opening titles' });
  workspace = createTarget(workspace, { id: 'target_one', referenceId: 'reference_one', kind: 'reference' });
  workspace = createBoard(workspace, { id: 'board_one', projectId: 'project_one', title: 'Direction' });
  return new MemoryRepository(workspace);
}

function client(store, options = {}) {
  const server = createMcpServer({ store, diagnostics: { write() {} }, ...options });
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    try { return { jsonrpc: '2.0', id, result: await server.handle({ id, method, ...(params ? { params } : {}) }) }; }
    catch (error) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32000, message: error.message, data: { code: error.mcpCode || error.code || 'INTERNAL_ERROR' } }
      };
    }
  };
  return { server, request };
}

test('create_project discovers and bootstraps an empty workspace', async t => {
  const store = new MemoryRepository();
  const mcp = client(store);
  t.after(() => mcp.server.close());

  const discovered = await mcp.request('tools/list');
  const tool = discovered.result.tools.find(item => item.name === 'create_project');
  assert.deepEqual(tool.inputSchema.required, ['title']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['title', 'brief', 'expectedRevision']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const emptyTags = await mcp.request('tools/call', { name: 'list_reference_tags', arguments: {} });
  assert.deepEqual(emptyTags.result.structuredContent.tags, [
    { tag: 'branding', referenceCount: 0 },
    { tag: 'editorial', referenceCount: 0 },
    { tag: 'illustration', referenceCount: 0 },
    { tag: 'motion', referenceCount: 0 },
    { tag: 'photography', referenceCount: 0 },
    { tag: 'typography', referenceCount: 0 },
    { tag: 'web-3d', referenceCount: 0 },
    { tag: 'web-design', referenceCount: 0 }
  ]);
  assert.deepEqual(tool.annotations, {
    title: 'create project', readOnlyHint: false, destructiveHint: false,
    idempotentHint: false, openWorldHint: false
  });

  const missing = await mcp.request('tools/call', { name: 'create_project', arguments: {} });
  assert.equal(missing.result.structuredContent.error.code, 'INVALID_ARGUMENT');
  const blank = await mcp.request('tools/call', { name: 'create_project', arguments: { title: '  ' } });
  assert.equal(blank.result.structuredContent.error.code, 'INVALID_ARGUMENT');

  const created = await mcp.request('tools/call', { name: 'create_project', arguments: {
    title: 'First project', brief: 'A bootstrapped workspace', expectedRevision: 1
  } });
  assert.equal(created.result.structuredContent.revision, 2);
  assert.equal(created.result.structuredContent.entity.title, 'First project');
  assert.equal(created.result.structuredContent.entity.brief, 'A bootstrapped workspace');
  assert.deepEqual(store.workspace.projects, [created.result.structuredContent.entity]);

  const stale = await mcp.request('tools/call', { name: 'create_project', arguments: {
    title: 'Stale project', expectedRevision: 1
  } });
  assert.equal(stale.result.structuredContent.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(stale.result.structuredContent.error.details, { expectedRevision: 1, actualRevision: 2 });
  assert.equal(store.workspace.projects.length, 1);
});

test('MCP reference tags stay ordered across writes, reads, search, and discovery', async t => {
  const store = fixture();
  const mcp = client(store);
  t.after(() => mcp.server.close());

  const discovered = await mcp.request('tools/list');
  const createTool = discovered.result.tools.find(tool => tool.name === 'create_reference');
  const updateTool = discovered.result.tools.find(tool => tool.name === 'enrich_reference');
  const tagTool = discovered.result.tools.find(tool => tool.name === 'list_reference_tags');
  assert.deepEqual(createTool.inputSchema.properties.tags, {
    type: 'array', description: 'Ordered reference tags', maxItems: 20,
    items: { type: 'string', maxLength: 64 }
  });
  assert.deepEqual(updateTool.inputSchema.properties.tags, createTool.inputSchema.properties.tags);
  assert.equal(tagTool.annotations.readOnlyHint, true);
  assert.equal(tagTool.inputSchema.properties.limit.maximum, 100);

  const created = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Tagged study',
    tags: ['Editorial Design', 'Motion', 'editorial-design'], expectedRevision: 1
  } });
  assert.deepEqual(created.result.structuredContent.entity.tags, ['editorial-design', 'motion']);

  const detail = await mcp.request('tools/call', { name: 'get_reference', arguments: {
    referenceId: created.result.structuredContent.entity.id
  } });
  assert.deepEqual(detail.result.structuredContent.reference.tags, ['editorial-design', 'motion']);

  const queryMatch = await mcp.request('tools/call', { name: 'search_references', arguments: {
    query: 'motion'
  } });
  assert.deepEqual(queryMatch.result.structuredContent.references[0].tags, ['editorial-design', 'motion']);
  const tagMatch = await mcp.request('tools/call', { name: 'search_references', arguments: {
    tag: 'Editorial Design'
  } });
  assert.deepEqual(tagMatch.result.structuredContent.references.map(reference => reference.id), [created.result.structuredContent.entity.id]);

  const updated = await mcp.request('tools/call', { name: 'enrich_reference', arguments: {
    referenceId: created.result.structuredContent.entity.id,
    tags: ['Motion', 'Typography', 'motion'], expectedRevision: 2
  } });
  assert.deepEqual(updated.result.structuredContent.entity.tags, ['motion', 'typography']);
  await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Second study',
    tags: ['Motion', 'Editorial'], expectedRevision: 3
  } });

  const tags = await mcp.request('tools/call', { name: 'list_reference_tags', arguments: {
    limit: 2
  } });
  assert.deepEqual(tags.result.structuredContent.tags, [
    { tag: 'motion', referenceCount: 2 },
    { tag: 'editorial', referenceCount: 1 }
  ]);
  assert.equal(tags.result.structuredContent.total, 8);
  assert.equal(tags.result.structuredContent.nextOffset, 2);
  const unused = await mcp.request('tools/call', { name: 'list_reference_tags', arguments: {
    offset: 3
  } });
  assert.deepEqual(unused.result.structuredContent.tags, [
    { tag: 'branding', referenceCount: 0 },
    { tag: 'illustration', referenceCount: 0 },
    { tag: 'photography', referenceCount: 0 },
    { tag: 'web-3d', referenceCount: 0 },
    { tag: 'web-design', referenceCount: 0 }
  ]);
  const suggestions = await mcp.request('tools/call', { name: 'list_reference_tags', arguments: {
    query: 'graph'
  } });
  assert.deepEqual(suggestions.result.structuredContent.tags, [
    { tag: 'typography', referenceCount: 1 },
    { tag: 'photography', referenceCount: 0 }
  ]);

  for (const invalid of [
    { projectId: 'project_one', tags: 'motion' },
    { projectId: 'project_one', tags: [1] },
    { projectId: 'project_one', tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }
  ]) {
    const response = await mcp.request('tools/call', { name: 'create_reference', arguments: invalid });
    assert.equal(response.result.structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  const invalidFilter = await mcp.request('tools/call', { name: 'search_references', arguments: { tag: '   ' } });
  assert.equal(invalidFilter.result.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('stdio discovery, progressive reads, additive writes, media, errors, and revisions', async t => {
  const store = fixture();
  const mcp = client(store);
  t.after(() => mcp.server.close());

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
  assert.equal(discovered.result.tools.find(tool => tool.name === 'create_reference').annotations.openWorldHint, true);
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

test('MCP reference creation defaults website capture on and supports both opt-out paths', async t => {
  const store = fixture();
  const calls = [];
  const mcp = client(store, {
    captureReference: async (...args) => {
      calls.push(args);
      return { status: 'complete', captured: [] };
    }
  });
  t.after(() => mcp.server.close());

  const automatic = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Website', sourceUrl: 'https://example.com'
  } });
  assert.equal(automatic.result.structuredContent.revision, 2);
  assert.equal(automatic.result.structuredContent.capture.status, 'queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], automatic.result.structuredContent.entity.id);
  const status = await mcp.request('tools/call', { name: 'get_capture_status', arguments: {
    referenceId: automatic.result.structuredContent.entity.id
  } });
  assert.equal(status.result.structuredContent.status, 'complete');

  const optedOut = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Saved only', sourceUrl: 'https://example.org',
    capture: false, expectedRevision: 2
  } });
  assert.deepEqual(optedOut.result.structuredContent.capture, {
    status: 'skipped', reason: 'explicit_opt_out'
  });
  assert.equal(calls.length, 1);

  store.workspace = updateWorkspaceSettings(store.workspace, { automaticWebsiteCapture: false });
  const preference = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Workspace default', sourceUrl: 'https://example.net',
    expectedRevision: 3
  } });
  assert.deepEqual(preference.result.structuredContent.capture, {
    status: 'skipped', reason: 'workspace_default'
  });
  assert.equal(calls.length, 1);

  const override = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', title: 'Override', sourceUrl: 'https://example.edu',
    capture: true, expectedRevision: 4
  } });
  assert.equal(override.result.structuredContent.capture.status, 'queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);

  const invalid = await mcp.request('tools/call', { name: 'create_reference', arguments: {
    projectId: 'project_one', capture: 'yes'
  } });
  assert.equal(invalid.result.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('injected MCP capture returns structured results and bounded tool errors', async () => {
  const store = new MemoryRepository();
  let next = { status: 'partial', captured: [{ assetId: 'a', targetId: 't', momentId: 'm', mediaId: 'hidden' }] };
  const calls = [];
  const diagnostics = [];
  const mcp = createMcpServer({ store, diagnostics: { write: value => diagnostics.push(value) }, captureReference: async (...args) => { calls.push(args); return next; } });
  const partial = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r', settings: { width: 800 } } } });
  assert.deepEqual(partial.structuredContent, { status: 'partial', captured: [{ assetId: 'a', targetId: 't', momentId: 'm' }] });
  assert.equal(calls[0][1], 'r');
  assert.equal(calls[0][2].width, 800);

  next = { status: 'failed', captured: [], error: 'CAPTURE_BUSY' };
  const busy = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r' } } });
  assert.equal(busy.isError, true);
  assert.equal(busy.structuredContent.error.code, 'CAPTURE_BUSY');

  next = { status: 'failed', captured: [], error: 'CAPTURE_FAILED', diagnostic: 'BROWSER_UNAVAILABLE' };
  const unavailable = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r' } } });
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.error.code, 'CAPTURE_FAILED');
  assert.doesNotMatch(JSON.stringify(unavailable), /BROWSER_UNAVAILABLE/);
  assert.equal(diagnostics.at(-1), 'Refloom MCP website capture diagnostic: BROWSER_UNAVAILABLE\n');

  const invalid = await mcp.handle({ method: 'tools/call', params: { name: 'request_website_capture', arguments: { referenceId: 'r', settings: { chromePath: '/tmp/chrome' } } } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT');
});

test('two MCP instances sharing one authoritative repository cannot silently overwrite', async t => {
  const store = fixture();
  const first = client(store);
  const second = client(store);
  t.after(() => Promise.all([first.server.close(), second.server.close()]));
  await Promise.all([first.request('initialize'), second.request('initialize')]);
  const calls = await Promise.all([
    first.request('tools/call', { name: 'create_reference', arguments: { projectId: 'project_one', title: 'A', expectedRevision: 1 } }),
    second.request('tools/call', { name: 'create_reference', arguments: { projectId: 'project_one', title: 'B', expectedRevision: 1 } })
  ]);
  assert.equal(calls.filter(item => item.result.isError).length, 1);
  assert.equal(calls.filter(item => !item.result.isError).length, 1);
  assert.equal(calls.find(item => item.result.isError).result.structuredContent.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(calls.find(item => item.result.isError).result.structuredContent.error.details, { expectedRevision: 1, actualRevision: 2 });
});

test('repository initialization and close each happen once', async () => {
  const store = fixture();
  const mcp = createMcpServer({ store });
  await Promise.all([mcp.initialize(), mcp.initialize(), mcp.handle({ method: 'ping' })]);
  await Promise.all([mcp.close(), mcp.close()]);
  assert.equal(store.calls.filter(value => value === 'initialize').length, 1);
  assert.equal(store.calls.filter(value => value === 'readiness').length, 1);
  assert.equal(store.calls.filter(value => value === 'close').length, 1);
});

test('unknown tool infrastructure errors and startup diagnostics redact secrets and URLs', async () => {
  const secret = 'postgres://user:password@example.invalid/database';
  const diagnostics = [];
  const store = fixture();
  store.load = async () => { throw new Error(secret); };
  const mcp = createMcpServer({ store, diagnostics: { write: value => diagnostics.push(value) } });
  const response = await mcp.handle({ method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
  assert.equal(response.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(response), /password|postgres:/);
  assert.doesNotMatch(diagnostics.join(''), /password|postgres:/);
});

test('runStdio initializes before serving and closes on EOF', async () => {
  const store = fixture();
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  await runStdio({ store, input, output, diagnostics: { write() {} } });
  assert.deepEqual(JSON.parse(text), { jsonrpc: '2.0', id: 1, result: {} });
  assert.deepEqual(store.calls, ['initialize', 'readiness', 'close']);
});
