#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import {
  createAsset, createMoment, createReference, createSelection, createTarget,
  exportCreativeDirection, updateReference
} from './src/domain.js';
import { FileWorkspaceStore, RevisionConflictError, StoreError } from './src/file-workspace-store.js';
import { blobIdFromLocator } from './src/storage.js';

const PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 16_384;
const MAX_QUERY = 512;
const MAX_LIMIT = 100;
const MAX_BINARY_BYTES = 25 * 1024 * 1024;
const MEDIA_URI = 'refloom://media/';
const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false });
const string = (description, maxLength = MAX_TEXT) => ({ type: 'string', description, maxLength });
const required = (schema, ...fields) => ({ ...schema, required: fields });
const page = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } };

const tools = [
  { name: 'list_projects', description: 'List paginated project summaries. Use get_project for detail.', inputSchema: objectSchema(page) },
  { name: 'get_project', description: 'Get one project and counts of its related records.', inputSchema: required(objectSchema({ projectId: string('Project ID', 128) }), 'projectId') },
  { name: 'list_boards', description: 'List paginated board summaries, optionally within a project.', inputSchema: objectSchema({ projectId: string('Project ID', 128), ...page }) },
  { name: 'get_board', description: 'Get a board and its ordered selection summaries.', inputSchema: required(objectSchema({ boardId: string('Board ID', 128) }), 'boardId') },
  { name: 'search_references', description: 'Search paginated reference summaries by title, creator, URL, or notes.', inputSchema: objectSchema({ projectId: string('Project ID', 128), query: string('Case-insensitive query', MAX_QUERY), ...page }) },
  { name: 'get_reference', description: 'Get a reference with paginated registered assets, targets, and moments.', inputSchema: required(objectSchema({ referenceId: string('Reference ID', 128), ...page }), 'referenceId') },
  { name: 'search_selections', description: 'Locate paginated selections by project, aspect, intent, or related reference title.', inputSchema: objectSchema({ projectId: string('Project ID', 128), aspect: string('Case-insensitive aspect filter', MAX_QUERY), query: string('Case-insensitive aspect, intent, or reference-title query', MAX_QUERY), ...page }) },
  { name: 'get_selection', description: 'Get a selection with its target, moment, reference, and asset.', inputSchema: required(objectSchema({ selectionId: string('Selection ID', 128) }), 'selectionId') },
  { name: 'get_creative_direction', description: 'Get versioned creative-direction export for one board, or all boards in one project.', inputSchema: objectSchema({ boardId: string('Board ID', 128), projectId: string('Project ID', 128) }) },
  { name: 'create_reference', description: 'Add a reference to an existing project.', inputSchema: required(objectSchema({ projectId: string('Project ID', 128), title: string('Title'), sourceUrl: string('Source URL'), creator: string('Creator'), notes: string('Notes'), captureMethod: string('Capture method', 128), expectedRevision: { type: 'integer', minimum: 0 } }), 'projectId') },
  { name: 'enrich_reference', description: 'Add or replace supplied descriptive fields on an existing reference; it never deletes the reference.', inputSchema: required(objectSchema({ referenceId: string('Reference ID', 128), title: string('Title'), sourceUrl: string('Source URL'), creator: string('Creator'), notes: string('Notes'), expectedRevision: { type: 'integer', minimum: 0 } }), 'referenceId') },
  { name: 'add_asset', description: 'Register a URL asset or add base64 image/video bytes to an existing reference.', inputSchema: required(objectSchema({ referenceId: string('Reference ID', 128), kind: { type: 'string', enum: ['url', 'image', 'video'] }, locator: string('Absolute http(s) URL for URL assets'), mediaType: string('MIME type', 255), filename: string('Original filename', 1024), data: string('Canonical base64 bytes for image/video assets', 36_000_000), provenance: { type: 'object' }, expectedRevision: { type: 'integer', minimum: 0 } }), 'referenceId', 'kind') },
  { name: 'create_target', description: 'Add a precise target to a reference.', inputSchema: required(objectSchema({ referenceId: string('Reference ID', 128), assetId: string('Asset ID', 128), kind: { type: 'string', enum: ['reference', 'asset', 'region', 'frame', 'interaction'] }, detail: { type: 'object' }, expectedRevision: { type: 'integer', minimum: 0 } }), 'referenceId', 'kind') },
  { name: 'create_moment', description: 'Add a moment to a target.', inputSchema: required(objectSchema({ targetId: string('Target ID', 128), label: string('Label'), start: { type: 'number', minimum: 0 }, end: { type: 'number', minimum: 0 }, state: { type: 'object' }, expectedRevision: { type: 'integer', minimum: 0 } }), 'targetId') },
  { name: 'create_selection', description: 'Add a selection expressing aspect and intent.', inputSchema: required(objectSchema({ projectId: string('Project ID', 128), targetId: string('Target ID', 128), momentId: string('Moment ID', 128), aspect: string('Relevant aspect'), intent: string('Intended use'), expectedRevision: { type: 'integer', minimum: 0 } }), 'projectId', 'targetId', 'aspect', 'intent') },
  { name: 'add_selection_to_board', description: 'Append an existing selection to an existing board.', inputSchema: required(objectSchema({ boardId: string('Board ID', 128), selectionId: string('Selection ID', 128), expectedRevision: { type: 'integer', minimum: 0 } }), 'boardId', 'selectionId') }
];
const readTools = new Set(['list_projects', 'get_project', 'list_boards', 'get_board', 'search_references', 'get_reference', 'search_selections', 'get_selection', 'get_creative_direction']);
for (const tool of tools) tool.annotations = {
  title: tool.name.replaceAll('_', ' '),
  readOnlyHint: readTools.has(tool.name),
  destructiveHint: false,
  idempotentHint: readTools.has(tool.name),
  openWorldHint: false
};
const toolsByName = new Map(tools.map(tool => [tool.name, tool]));

function fail(code, message, details) {
  const error = new Error(message);
  error.mcpCode = code;
  error.details = details;
  throw error;
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${name} must be an object`);
  return value;
}

function entity(workspace, collection, id) {
  const found = workspace[collection].find(item => item.id === id);
  if (!found) fail('NOT_FOUND', `${collection} does not contain ${id}`);
  return found;
}

function limit(value) { return value === undefined ? 25 : value; }
function offset(value) { return value ?? 0; }
function paged(values, args) {
  const start = offset(args.offset);
  const items = values.slice(start, start + limit(args.limit));
  return { items, total: values.length, offset: start, nextOffset: start + items.length < values.length ? start + items.length : null };
}
function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(error) {
  const code = error.mcpCode || error.code || (error instanceof TypeError ? 'INVALID_ARGUMENT' : error instanceof RangeError ? 'NOT_FOUND' : 'INTERNAL_ERROR');
  const safe = error.mcpCode || error instanceof StoreError || error instanceof TypeError || error instanceof RangeError;
  const value = { error: { code, message: safe ? error.message : 'The operation failed inside the local Refloom server', ...(safe && error.details ? { details: error.details } : {}) } };
  return { ...result(value), isError: true };
}

function validateStrings(value) {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.length > (key === 'query' ? MAX_QUERY : key === 'data' ? 36_000_000 : MAX_TEXT)) fail('INVALID_ARGUMENT', `${key} is too long`);
  }
}

function validateArguments(name, args) {
  const tool = toolsByName.get(name);
  if (!tool) fail('METHOD_NOT_FOUND', `Unknown tool ${name}`);
  const schema = tool.inputSchema;
  for (const field of schema.required ?? []) if (args[field] === undefined) fail('INVALID_ARGUMENT', `${field} is required`);
  for (const [field, value] of Object.entries(args)) {
    const property = schema.properties[field];
    if (!property) fail('INVALID_ARGUMENT', `${field} is not accepted by ${name}`);
    if (property.type === 'string' && typeof value !== 'string') fail('INVALID_ARGUMENT', `${field} must be a string`);
    if (property.type === 'integer' && !Number.isSafeInteger(value)) fail('INVALID_ARGUMENT', `${field} must be an integer`);
    if (property.type === 'number' && !Number.isFinite(value)) fail('INVALID_ARGUMENT', `${field} must be a finite number`);
    if (property.type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) fail('INVALID_ARGUMENT', `${field} must be an object`);
    if (property.minimum !== undefined && value < property.minimum) fail('INVALID_ARGUMENT', `${field} is below its minimum`);
    if (property.maximum !== undefined && value > property.maximum) fail('INVALID_ARGUMENT', `${field} exceeds its maximum`);
    if (property.maxLength !== undefined && value.length > property.maxLength) fail('INVALID_ARGUMENT', `${field} is too long`);
    if (property.enum && !property.enum.includes(value)) fail('INVALID_ARGUMENT', `${field} has an unsupported value`);
  }
  validateStrings(args);
}

function selectionDetail(workspace, selection) {
  const target = entity(workspace, 'targets', selection.targetId);
  const reference = entity(workspace, 'references', target.referenceId);
  return {
    selection,
    target,
    moment: selection.momentId ? entity(workspace, 'moments', selection.momentId) : null,
    reference,
    asset: target.assetId ? entity(workspace, 'assets', target.assetId) : null
  };
}

function mediaResource(asset) {
  const id = blobIdFromLocator(asset.locator);
  if (!id) return null;
  return {
    uri: `${MEDIA_URI}${id}`,
    name: asset.provenance?.filename || asset.id,
    mimeType: asset.mediaType || 'application/octet-stream',
    description: `Registered media for reference ${asset.referenceId}`,
    _meta: { assetId: asset.id, referenceId: asset.referenceId, provenance: asset.provenance }
  };
}

export function createMcpServer(options = {}) {
  const store = options.store ?? new FileWorkspaceStore({ directory: options.dataDirectory ?? process.env.REFLOOM_DATA_DIR ?? path.resolve('data') });
  const diagnostics = options.diagnostics ?? process.stderr;

  async function mutate(args, operation) {
    const current = await store.load();
    const expected = args.expectedRevision ?? current.revision;
    if (expected !== current.revision) throw new RevisionConflictError(expected, current.revision);
    const changed = operation(current.workspace);
    const workspace = changed.workspace ?? changed;
    const committed = await store.commit(expected, workspace, changed.additions ?? []);
    return { revision: committed.revision, entity: changed.entity ? changed.entity(committed.workspace) : undefined };
  }

  async function callTool(name, raw) {
    const args = record(raw ?? {}, 'arguments');
    validateArguments(name, args);
    const { revision, workspace } = await store.load();
    if (name === 'list_projects') {
      const found = paged(workspace.projects.map(({ id, title, brief, updatedAt }) => ({ id, title, brief, updatedAt })), args);
      return { revision, projects: found.items, total: found.total, offset: found.offset, nextOffset: found.nextOffset };
    }
    if (name === 'get_project') {
      const project = entity(workspace, 'projects', args.projectId);
      const count = collection => workspace[collection].filter(item => item.projectId === project.id).length;
      return { revision, project, counts: Object.fromEntries(['references', 'assets', 'targets', 'moments', 'selections', 'boards'].map(key => [key, count(key)])) };
    }
    if (name === 'list_boards') {
      const found = paged(workspace.boards.filter(item => !args.projectId || item.projectId === args.projectId).map(({ id, projectId, title, selectionIds, updatedAt }) => ({ id, projectId, title, selectionCount: selectionIds.length, updatedAt })), args);
      return { revision, boards: found.items, total: found.total, offset: found.offset, nextOffset: found.nextOffset };
    }
    if (name === 'get_board') {
      const board = entity(workspace, 'boards', args.boardId);
      return { revision, board, selections: board.selectionIds.map(id => selectionDetail(workspace, entity(workspace, 'selections', id)).selection) };
    }
    if (name === 'search_references') {
      const query = (args.query ?? '').toLocaleLowerCase();
      const matches = workspace.references.filter(item => (!args.projectId || item.projectId === args.projectId) && (!query || [item.title, item.creator, item.sourceUrl, item.notes].some(value => value?.toLocaleLowerCase().includes(query)))).map(({ id, projectId, title, sourceUrl, creator, capturedAt, updatedAt }) => ({ id, projectId, title, sourceUrl, creator, capturedAt, updatedAt }));
      const found = paged(matches, args);
      return { revision, references: found.items, total: found.total, offset: found.offset, nextOffset: found.nextOffset };
    }
    if (name === 'get_reference') {
      const reference = entity(workspace, 'references', args.referenceId);
      const allTargets = workspace.targets.filter(item => item.referenceId === reference.id);
      const assets = paged(workspace.assets.filter(item => item.referenceId === reference.id).map(item => ({ ...item, resourceUri: mediaResource(item)?.uri })), args);
      const targets = paged(allTargets, args);
      const moments = paged(workspace.moments.filter(item => allTargets.some(target => target.id === item.targetId)), args);
      return { revision, reference, assets: assets.items, targets: targets.items, moments: moments.items, page: { offset: assets.offset, nextOffsets: { assets: assets.nextOffset, targets: targets.nextOffset, moments: moments.nextOffset }, totals: { assets: assets.total, targets: targets.total, moments: moments.total } } };
    }
    if (name === 'search_selections') {
      const aspect = (args.aspect ?? '').toLocaleLowerCase();
      const query = (args.query ?? '').toLocaleLowerCase();
      const matches = workspace.selections.filter(selection => {
        if (args.projectId && selection.projectId !== args.projectId) return false;
        if (aspect && !selection.aspect.toLocaleLowerCase().includes(aspect)) return false;
        const detail = selectionDetail(workspace, selection);
        return !query || [selection.aspect, selection.intent, detail.reference.title].some(value => value?.toLocaleLowerCase().includes(query));
      }).map(selection => {
        const detail = selectionDetail(workspace, selection);
        return { ...selection, referenceId: detail.reference.id, referenceTitle: detail.reference.title, assetId: detail.asset?.id };
      });
      const found = paged(matches, args);
      return { revision, selections: found.items, total: found.total, offset: found.offset, nextOffset: found.nextOffset };
    }
    if (name === 'get_selection') return { revision, ...selectionDetail(workspace, entity(workspace, 'selections', args.selectionId)) };
    if (name === 'get_creative_direction') {
      if (Boolean(args.boardId) === Boolean(args.projectId)) fail('INVALID_ARGUMENT', 'Provide exactly one of boardId or projectId');
      if (args.boardId) return { revision, creativeDirection: exportCreativeDirection(workspace, args.boardId) };
      entity(workspace, 'projects', args.projectId);
      return { revision, creativeDirections: workspace.boards.filter(board => board.projectId === args.projectId).map(board => exportCreativeDirection(workspace, board.id)) };
    }
    if (name === 'create_reference') return mutate(args, value => {
      const next = createReference(value, { ...args, captureMethod: args.captureMethod || 'mcp-agent' });
      const id = next.references.at(-1).id;
      return { workspace: next, entity: saved => entity(saved, 'references', id) };
    });
    if (name === 'enrich_reference') return mutate(args, value => {
      const changes = Object.fromEntries(['title', 'sourceUrl', 'creator', 'notes'].filter(key => key in args).map(key => [key, args[key]]));
      if (!Object.keys(changes).length) fail('INVALID_ARGUMENT', 'At least one enrichment field is required');
      const next = updateReference(value, args.referenceId, changes);
      return { workspace: next, entity: saved => entity(saved, 'references', args.referenceId) };
    });
    if (name === 'add_asset') return mutate(args, value => {
      let locator = args.locator;
      const additions = [];
      const provenance = { captureMethod: 'mcp-agent', importedAt: new Date().toISOString(), ...(args.provenance ?? {}), ...(args.filename ? { filename: args.filename } : {}) };
      if (args.kind === 'url') {
        try { if (!/^https?:$/.test(new URL(locator).protocol)) throw new Error(); }
        catch { fail('INVALID_ARGUMENT', 'URL assets require an absolute http(s) locator'); }
        if (args.data !== undefined) fail('INVALID_ARGUMENT', 'URL assets cannot contain binary data');
      } else {
        if (!args.mediaType || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(args.mediaType)) fail('INVALID_ARGUMENT', 'Binary assets require a valid mediaType');
        if (typeof args.data !== 'string') fail('INVALID_ARGUMENT', 'Binary assets require canonical base64 data');
        const bytes = Buffer.from(args.data, 'base64');
        if (bytes.length > MAX_BINARY_BYTES || bytes.toString('base64') !== args.data) fail('INVALID_ARGUMENT', 'Binary data is invalid or too large');
        const mediaId = crypto.randomUUID();
        locator = `blob:${mediaId}`;
        additions.push({ id: mediaId, data: args.data });
      }
      const next = createAsset(value, { ...args, locator, provenance });
      const id = next.assets.at(-1).id;
      return { workspace: next, additions, entity: saved => entity(saved, 'assets', id) };
    });
    if (name === 'create_target') return mutate(args, value => {
      const next = createTarget(value, args); const id = next.targets.at(-1).id;
      return { workspace: next, entity: saved => entity(saved, 'targets', id) };
    });
    if (name === 'create_moment') return mutate(args, value => {
      const next = createMoment(value, args); const id = next.moments.at(-1).id;
      return { workspace: next, entity: saved => entity(saved, 'moments', id) };
    });
    if (name === 'create_selection') return mutate(args, value => {
      const next = createSelection(value, args); const id = next.selections.at(-1).id;
      return { workspace: next, entity: saved => entity(saved, 'selections', id) };
    });
    if (name === 'add_selection_to_board') return mutate(args, value => {
      const board = entity(value, 'boards', args.boardId);
      const selection = entity(value, 'selections', args.selectionId);
      if (selection.projectId !== board.projectId) fail('INVALID_ARGUMENT', 'Selection must belong to the board project');
      if (board.selectionIds.includes(selection.id)) fail('ALREADY_EXISTS', 'Selection is already on the board');
      const next = structuredClone(value);
      const saved = next.boards.find(item => item.id === board.id);
      saved.selectionIds.push(selection.id);
      saved.updatedAt = new Date().toISOString();
      return { workspace: next, entity: committed => entity(committed, 'boards', board.id) };
    });
    fail('METHOD_NOT_FOUND', `Unknown tool ${name}`);
  }

  async function handle(request) {
    const method = request.method;
    if (method === 'initialize') return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: 'refloom', version: '0.1.0' }, instructions: 'Use list/search tools before detail tools. Mutations are additive-only. Media is available only through registered refloom://media resources.' };
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools };
    if (method === 'tools/call') {
      try { return result(await callTool(request.params?.name, request.params?.arguments)); }
      catch (error) {
        if (!error.mcpCode && !(error instanceof StoreError) && !(error instanceof TypeError) && !(error instanceof RangeError)) diagnostics.write(`Refloom MCP internal tool error: ${error.name}\n`);
        return toolError(error);
      }
    }
    if (method === 'resources/list') {
      const { workspace } = await store.load();
      const resources = workspace.assets.map(mediaResource).filter(Boolean);
      const start = request.params?.cursor === undefined ? 0 : Number(request.params.cursor);
      if (!Number.isSafeInteger(start) || start < 0) fail('INVALID_ARGUMENT', 'Resource cursor is invalid');
      const items = resources.slice(start, start + MAX_LIMIT);
      return { resources: items, ...(start + items.length < resources.length ? { nextCursor: String(start + items.length) } : {}) };
    }
    if (method === 'resources/templates/list') return { resourceTemplates: [{ uriTemplate: `${MEDIA_URI}{mediaId}`, name: 'Registered Refloom media', description: 'Binary content for a media asset referenced by the authoritative workspace' }] };
    if (method === 'resources/read') {
      const uri = request.params?.uri;
      if (typeof uri !== 'string' || !uri.startsWith(MEDIA_URI)) fail('INVALID_RESOURCE_URI', 'Only refloom://media resources are supported');
      const id = decodeURIComponent(uri.slice(MEDIA_URI.length));
      const { workspace } = await store.load();
      const asset = workspace.assets.find(item => blobIdFromLocator(item.locator) === id);
      if (!asset) fail('RESOURCE_NOT_FOUND', 'Media is not registered by an authoritative workspace asset');
      const media = await store.mediaInfo(id);
      return { contents: [{ uri, mimeType: media.mediaType, blob: media.contents.toString('base64'), _meta: { assetId: asset.id, referenceId: asset.referenceId, provenance: asset.provenance } }] };
    }
    fail('METHOD_NOT_FOUND', `Unsupported method ${method}`);
  }

  return { initialize: () => store.initialize(), handle };
}

export async function runStdio(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const server = createMcpServer(options);
  await server.initialize();
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { diagnostics.write('Refloom MCP: request exceeded line limit\n'); continue; }
    let request;
    try { request = JSON.parse(line); }
    catch { diagnostics.write('Refloom MCP: ignored invalid JSON input\n'); continue; }
    if (request.id === undefined) continue;
    try { output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: await server.handle(request) })}\n`); }
    catch (error) {
      const code = error.mcpCode === 'METHOD_NOT_FOUND' ? -32601 : error.mcpCode?.startsWith('INVALID_') ? -32602 : -32000;
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: error.message, data: { code: error.mcpCode || error.code || 'INTERNAL_ERROR', ...(error instanceof RevisionConflictError ? { expected: error.expected, actual: error.actual } : {}) } } })}\n`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runStdio().catch(error => { process.stderr.write(`Refloom MCP failed: ${error.message}\n`); process.exitCode = 1; });
}
