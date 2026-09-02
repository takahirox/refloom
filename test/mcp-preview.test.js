import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../mcp-server.mjs';
import { EphemeralPreviewService } from '../src/ephemeral-preview-service.js';
import {
  createAsset, createMoment, createProject, createReference, createSelection, createTarget,
  createWorkspace
} from '../src/domain.js';

test('MCP composes bounded experience evidence before preview observation without workspace mutation', async t => {
  let workspace = createProject(createWorkspace(), { id: 'project-game', title: 'Game feel' });
  workspace = createReference(workspace, { id: 'reference-game', projectId: 'project-game', title: 'Jump study' });
  workspace = createAsset(workspace, {
    id: 'asset-video', referenceId: 'reference-game', kind: 'video',
    locator: 'blob:reference-video', mediaType: 'video/mp4', provenance: { filename: 'jump.mp4' }
  });
  workspace = createTarget(workspace, {
    id: 'target-jump', referenceId: 'reference-game', assetId: 'asset-video',
    kind: 'interaction', detail: { input: 'press', feedback: 'lift' }
  });
  workspace = createMoment(workspace, { id: 'moment-land', targetId: 'target-jump', label: 'Land', start: 2, end: 3, state: { observable: 'settled' } });
  workspace = createMoment(workspace, { id: 'moment-input', targetId: 'target-jump', label: 'Input', start: 0, end: 0.25, state: { input: 'press' } });
  workspace = createMoment(workspace, { id: 'moment-lift', targetId: 'target-jump', label: 'Lift', start: 0.25, end: 2, state: { feedback: 'rising' } });
  workspace = createSelection(workspace, {
    id: 'selection-jump', projectId: 'project-game', targetId: 'target-jump',
    momentId: 'moment-lift', aspect: 'Input feedback', intent: 'Keep the response immediate'
  });
  const originalWorkspace = structuredClone(workspace);
  const store = {
    revision: 7, commits: 0,
    async initialize() {},
    async readiness() { return true; },
    async load() { return { revision: this.revision, workspace: structuredClone(workspace) }; },
    async commit() { this.commits += 1; throw new Error('unexpected commit'); },
    async mediaInfo() { return { mediaType: 'video/mp4', contents: Buffer.from('reference-video') }; },
    async close() {}
  };
  const ids = ['capture-id', 'media-id'];
  const previewService = new EphemeralPreviewService({
    uuid: () => ids.shift(),
    captureWebsite: async (_url, options) => options.onScreenshot({
      png: Buffer.from('preview').toString('base64'),
      originalUrl: 'https://example.com/', finalUrl: 'https://example.com/',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      preset: 'desktop', mode: 'viewport',
      region: { x: 0, y: 0, width: 1440, height: 900 },
      scroll: { x: 0, y: 0 }, checkpoint: { index: 0, y: 0, count: 1 },
      capturedAt: '2026-09-02T00:00:00.000Z',
      captureMethod: 'automated-browser', captureStrategy: 'viewport'
    })
  });
  const server = createMcpServer({ store, previewService, diagnostics: { write() {} } });
  t.after(() => server.close());

  const listed = await server.handle({ method: 'tools/list' });
  const captureTool = listed.tools.find(tool => tool.name === 'capture_implementation_preview');
  const experienceTool = listed.tools.find(tool => tool.name === 'get_experience_sequence');
  assert.equal(captureTool.annotations.openWorldHint, true);
  assert.deepEqual(captureTool.inputSchema.properties.urlPolicy.enum, ['public', 'loopback']);
  assert.equal(experienceTool.annotations.readOnlyHint, true);
  assert.equal(experienceTool.inputSchema.properties.limit.maximum, 100);

  const sequence = await server.handle({ method: 'tools/call', params: {
    name: 'get_experience_sequence', arguments: { selectionId: 'selection-jump', limit: 2 }
  } });
  assert.equal(sequence.structuredContent.revision, 7);
  assert.equal(sequence.structuredContent.experience.reference.id, 'reference-game');
  assert.equal(sequence.structuredContent.experience.asset.resourceUri, 'refloom://media/reference-video');
  assert.deepEqual(sequence.structuredContent.experience.target.detail, { input: 'press', feedback: 'lift' });
  assert.equal(sequence.structuredContent.experience.selectedMoment.id, 'moment-lift');
  assert.deepEqual(
    sequence.structuredContent.experience.moments.map(moment => [moment.id, moment.start, moment.end, moment.state]),
    [
      ['moment-input', 0, 0.25, { input: 'press' }],
      ['moment-lift', 0.25, 2, { feedback: 'rising' }]
    ]
  );
  assert.equal(sequence.structuredContent.experience.selection.aspect, 'Input feedback');
  assert.equal(sequence.structuredContent.experience.selection.intent, 'Keep the response immediate');
  assert.deepEqual(sequence.structuredContent.page, { offset: 0, nextOffset: 2, total: 3 });
  const continuation = await server.handle({ method: 'tools/call', params: {
    name: 'get_experience_sequence', arguments: { selectionId: 'selection-jump', offset: 2, limit: 2 }
  } });
  assert.deepEqual(
    continuation.structuredContent.experience.moments.map(moment => moment.id),
    ['moment-land']
  );
  assert.deepEqual(continuation.structuredContent.page, { offset: 2, nextOffset: null, total: 3 });
  const overLimit = await server.handle({ method: 'tools/call', params: {
    name: 'get_experience_sequence', arguments: { selectionId: 'selection-jump', limit: 101 }
  } });
  assert.equal(overLimit.structuredContent.error.code, 'INVALID_ARGUMENT');
  const referenceMedia = await server.handle({ method: 'resources/read', params: {
    uri: sequence.structuredContent.experience.asset.resourceUri
  } });
  assert.equal(Buffer.from(referenceMedia.contents[0].blob, 'base64').toString(), 'reference-video');
  await assert.rejects(
    () => server.handle({ method: 'resources/read', params: { uri: 'refloom://media/unregistered' } }),
    error => error.mcpCode === 'RESOURCE_NOT_FOUND'
  );

  const queued = await server.handle({ method: 'tools/call', params: {
    name: 'capture_implementation_preview',
    arguments: { url: 'https://example.com/', settings: { mode: 'viewport' } }
  } });
  assert.deepEqual(queued.structuredContent, { captureId: 'capture-id', status: 'queued' });
  await previewService.wait('capture-id');
  const status = await server.handle({ method: 'tools/call', params: {
    name: 'get_implementation_preview', arguments: { captureId: 'capture-id' }
  } });
  assert.equal(status.structuredContent.resources[0].uri, 'refloom://preview/media-id');
  const media = await server.handle({ method: 'resources/read', params: {
    uri: 'refloom://preview/media-id'
  } });
  assert.equal(Buffer.from(media.contents[0].blob, 'base64').toString(), 'preview');
  const resources = await server.handle({ method: 'resources/list' });
  assert.equal(resources.resources.length, 1, 'temporary media stays out of durable discovery');
  assert.equal(store.revision, 7);
  assert.equal(store.commits, 0);
  assert.deepEqual(workspace, originalWorkspace);
});
