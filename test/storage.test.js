import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsset, createProject, createReference, createWorkspace } from '../src/domain.js';
import {
  BACKUP_FORMAT, blobIdFromLocator, decodeBackup, deserializeWorkspace,
  encodeBackup, referencedBlobIds, serializeWorkspace
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

test('backup encoding includes validated workspace and binaries', () => {
  const workspace = workspaceWithBlob();
  const text = encodeBackup(workspace, [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]);
  const parsed = JSON.parse(text);
  assert.equal(parsed.format, BACKUP_FORMAT);
  assert.deepEqual(decodeBackup(text), {
    workspace,
    binaries: [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]
  });
});

test('backup decoder rejects unsupported, corrupt, and incomplete backups', () => {
  const workspace = workspaceWithBlob();
  assert.throws(() => decodeBackup('{}'), /unsupported/i);
  assert.throws(() => decodeBackup('{'), /valid JSON/i);
  assert.throws(() => decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, workspace, binaries: [] })), /unsupported/i);
  assert.throws(() => decodeBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1, workspace, binaries: [] })), /missing binary/i);
  assert.throws(() => decodeBackup(JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    workspace,
    binaries: [
      { id: 'binary-1', type: 'image/png', data: 'AA==' },
      { id: 'binary-1', type: 'image/png', data: 'AA==' }
    ]
  })), /corrupt/i);
});

test('backup decoder omits orphaned binary records', () => {
  const workspace = workspaceWithBlob();
  const backup = decodeBackup(encodeBackup(workspace, [
    { id: 'binary-1', type: 'image/png', data: 'AA==' },
    { id: 'orphan', type: 'image/png', data: 'AA==' }
  ]));
  assert.deepEqual(backup.binaries.map(item => item.id), ['binary-1']);
});
