import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../mcp-server.mjs';
import { EphemeralPreviewService } from '../src/ephemeral-preview-service.js';
import { createWorkspace } from '../src/domain.js';

test('MCP exposes preview capture and resource reads without workspace mutation', async t => {
  const workspace = createWorkspace();
  const store = {
    revision: 7, commits: 0,
    async initialize() {},
    async readiness() { return true; },
    async load() { return { revision: this.revision, workspace: structuredClone(workspace) }; },
    async commit() { this.commits += 1; throw new Error('unexpected commit'); },
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
  assert.equal(captureTool.annotations.openWorldHint, true);
  assert.deepEqual(captureTool.inputSchema.properties.urlPolicy.enum, ['public', 'loopback']);

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
  assert.equal(resources.resources.length, 0, 'temporary media stays out of durable discovery');
  assert.equal(store.revision, 7);
  assert.equal(store.commits, 0);
  assert.deepEqual(workspace, createWorkspace());
});
