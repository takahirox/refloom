import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsset, createProject, createReference, createWorkspace } from '../src/domain.js';
import {
  BACKUP_FORMAT, BACKUP_VERSION, blobIdFromLocator, decodeBackup, deserializeWorkspace,
  encodeBackup, referencedBlobIds, serializeWorkspace, WorkspaceRepository
} from '../src/storage.js';

function workspaceWithBlob() {
  let workspace = createProject(createWorkspace(), { id: 'project-1', title: 'Test' });
  workspace = createReference(workspace, { id: 'reference-1', projectId: 'project-1', captureMethod: 'file' });
  return createAsset(workspace, { id: 'asset-1', referenceId: 'reference-1', kind: 'image', locator: 'blob:binary-1' });
}

test('workspace serialization validates and round trips', () => {
  const workspace = workspaceWithBlob();
  assert.deepEqual(deserializeWorkspace(serializeWorkspace(workspace)), workspace);
  assert.throws(() => serializeWorkspace({ version: 999 }), /validation/i);
  assert.throws(() => deserializeWorkspace('not json'), /validation/i);
});

test('blob locator helpers distinguish local binaries', () => {
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
  const wrongOrder = { type: zero.type, id: zero.id, name: zero.name, size: zero.size, sha256: zero.sha256, data: zero.data };
  assert.throws(() => decodeBackup(envelope([wrongOrder])), /keys/i);
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
