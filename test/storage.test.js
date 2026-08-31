import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAsset, createProject, createReference, createWorkspace } from '../src/domain.js';
import {
  BACKUP_FORMAT, BACKUP_VERSION, blobIdFromLocator, decodeBackup, encodeBackup,
  referencedBlobIds, RevisionConflictError, WorkspaceRepository
} from '../src/storage.js';

function workspaceWithBlob() {
  let workspace = createProject(createWorkspace(), { id: 'project-1', title: 'Test' });
  workspace = createReference(workspace, { id: 'reference-1', projectId: 'project-1', captureMethod: 'file' });
  return createAsset(workspace, { id: 'asset-1', referenceId: 'reference-1', kind: 'image', locator: 'blob:binary-1' });
}

test('storage module has no browser database or legacy migration path', () => {
  const source = readFileSync(new URL('../src/storage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /indexeddb/i);
  assert.doesNotMatch(source, /legacy|migrationPayload|readLegacyMigration/);
});

test('blob locator helpers distinguish referenced binaries', () => {
  assert.equal(blobIdFromLocator('blob:abc'), 'abc');
  assert.equal(blobIdFromLocator('https://example.com'), null);
  assert.deepEqual([...referencedBlobIds(workspaceWithBlob())], ['binary-1']);
});

const zero = { id: 'binary-1', type: 'image/png', name: 'one.png', size: 1, sha256: '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d', data: 'AA==' };

test('backup encoding is deterministic, cloned, sorted, and integrity checked', () => {
  const workspace = workspaceWithBlob();
  const text = encodeBackup(workspace, [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, BACKUP_FORMAT);
  assert.equal(parsed.version, BACKUP_VERSION);
  assert.deepEqual(parsed.binaries[0], zero);
  assert.deepEqual(Object.keys(parsed.binaries[0]), ['id', 'type', 'name', 'size', 'sha256', 'data']);
  assert.deepEqual(decodeBackup(text), { workspace, binaries: [zero] });
  parsed.workspace.projects[0].title = 'mutated';
  parsed.binaries[0].name = 'mutated';
  assert.equal(workspace.projects[0].title, 'Test');
  assert.equal(encodeBackup(workspace, [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]), text);
});

test('backup encoding rejects invalid and inconsistent binary records', () => {
  const workspace = workspaceWithBlob();
  assert.throws(() => encodeBackup(workspace, [{ ...zero, data: 'A===' }]), /base64/i);
  assert.throws(() => encodeBackup(workspace, [{ ...zero, id: '../bad' }]), /invalid/i);
  assert.throws(() => encodeBackup(workspace, [{ ...zero, type: 1 }]), /invalid/i);
  assert.throws(() => encodeBackup(workspace, [{ ...zero, name: 1 }]), /invalid/i);
  assert.throws(() => encodeBackup(workspace, [{ ...zero, size: 2 }]), /size/i);
  assert.throws(() => encodeBackup(workspace, [{ ...zero, sha256: 'A'.repeat(64) }]), /SHA-256/i);
  assert.throws(() => encodeBackup(workspace, [zero, zero]), /duplicated/i);
  assert.throws(() => encodeBackup(workspace, []), /missing/i);
  assert.throws(() => encodeBackup(workspace, [zero, { ...zero, id: 'orphan' }]), /orphaned/i);
});

test('backup decoder rejects unsupported envelopes and workspace errors', () => {
  const workspace = workspaceWithBlob();
  assert.throws(() => decodeBackup('{}'), /unsupported/i);
  assert.throws(() => decodeBackup('{'), /valid JSON/i);
  assert.throws(() => decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, workspace, binaries: [] })), /unsupported/i);
  assert.throws(() => decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, workspace, binaries: [zero] })), /version/i);
  assert.throws(() => decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 2, workspace: { version: 999 }, binaries: [zero] })), /validation/i);
});

test('backup decoder validates exact records, correspondence, size, and digest', () => {
  const workspace = workspaceWithBlob();
  const envelope = binaries => JSON.stringify({ format: BACKUP_FORMAT, version: 2, workspace, binaries });
  assert.throws(() => decodeBackup(envelope([])), /missing/i);
  assert.throws(() => decodeBackup(envelope([zero, zero])), /duplicated/i);
  assert.throws(() => decodeBackup(envelope([zero, { ...zero, id: 'orphan' }])), /orphaned/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, data: 'A===' }])), /base64/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, id: '../bad' }])), /invalid/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, type: 1 }])), /invalid/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, name: 1 }])), /invalid/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, size: -1 }])), /size/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, size: 2 }])), /size/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, sha256: zero.sha256.toUpperCase() }])), /SHA-256/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, sha256: '0'.repeat(64) }])), /SHA-256/i);
  assert.throws(() => decodeBackup(envelope([{ ...zero, extra: true }])), /keys/i);
  const { name, ...missingName } = zero;
  assert.throws(() => decodeBackup(envelope([missingName])), /keys/i);
});

test('backup decoder returns sorted cloned data', () => {
  let workspace = workspaceWithBlob();
  workspace = createAsset(workspace, { id: 'asset-2', referenceId: 'reference-1', kind: 'image', locator: 'blob:binary-0' });
  const other = { ...zero, id: 'binary-0' };
  const backup = decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 2, workspace, binaries: [zero, other] }));
  assert.deepEqual(backup.binaries.map(item => item.id), ['binary-0', 'binary-1']);
  backup.workspace.projects[0].title = 'mutated';
  backup.binaries[0].name = 'mutated';
  assert.equal(workspace.projects[0].title, 'Test');
  assert.equal(other.name, 'one.png');
});

test('backup decoder treats JSON object key order as insignificant', () => {
  const workspace = workspaceWithBlob();
  const original = JSON.parse(encodeBackup(workspace, [{
    id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA=='
  }]));
  const binary = original.binaries[0];
  original.binaries[0] = {
    data: binary.data,
    sha256: binary.sha256,
    size: binary.size,
    name: binary.name,
    type: binary.type,
    id: binary.id
  };
  assert.deepEqual(decodeBackup(JSON.stringify(original)).workspace, workspace);
});

test('WorkspaceRepository loads and mutates through the same-origin HTTP adapter', async () => {
  const workspace = workspaceWithBlob();
  const calls = [];
  const repository = new WorkspaceRepository(async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'PUT') return new Response(JSON.stringify({ revision: 'revision-2' }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ revision: 'revision-1', workspace }), { headers: { 'Content-Type': 'application/json' } });
  });

  assert.deepEqual(await repository.load(), workspace);
  await repository.mutate(workspace);
  assert.equal(calls[0].path, '/api/workspace');
  assert.equal(calls[1].path, '/api/workspace');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { revision: 'revision-1', workspace, binaries: [] });
  assert.equal(repository.revision, 'revision-2');
});

test('WorkspaceRepository reloads after an HTTP revision conflict', async () => {
  const workspace = workspaceWithBlob();
  let calls = 0;
  const repository = new WorkspaceRepository(async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 409 });
    return new Response(JSON.stringify({ revision: 'latest', workspace }), { headers: { 'Content-Type': 'application/json' } });
  });

  await assert.rejects(repository.mutate(workspace), RevisionConflictError);
  assert.equal(calls, 2);
  assert.equal(repository.revision, 'latest');
});

test('WorkspaceRepository preserves backup endpoints and reset behavior', async () => {
  const workspace = workspaceWithBlob();
  const empty = createWorkspace();
  const calls = [];
  const repository = new WorkspaceRepository(async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/backup' && !options.method) return new Response('backup-v2');
    if (path === '/api/backup') return new Response(JSON.stringify({ revision: 'restored', workspace }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ revision: 'reset' }), { headers: { 'Content-Type': 'application/json' } });
  });

  repository.revision = 'before';
  assert.equal(await repository.exportBackup(), 'backup-v2');
  assert.deepEqual(await repository.importBackup(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION })), workspace);
  assert.deepEqual(await repository.reset(), empty);
  assert.equal(calls[0].path, '/api/backup');
  assert.equal(calls[1].path, '/api/backup');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(JSON.parse(calls[1].options.body).revision, 'before');
  assert.equal(calls[2].path, '/api/workspace');
  assert.equal(calls[2].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[2].options.body).workspace, empty);
  assert.equal(repository.revision, 'reset');
});

test('WorkspaceRepository sends a bounded website capture request', async () => {
  const calls = [];
  const repository = new WorkspaceRepository(async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ status: 'complete', captured: [] }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  });
  const result = await repository.captureWebsite('reference-1', { width: 800 });
  assert.equal(result.status, 'complete');
  assert.equal(calls[0].path, '/api/captures');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { referenceId: 'reference-1', settings: { width: 800 } });
});
