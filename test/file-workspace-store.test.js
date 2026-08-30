import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createAsset, createProject, createReference, createWorkspace } from '../src/domain.js';
import { FileWorkspaceStore, LockTimeoutError, RevisionConflictError } from '../src/file-workspace-store.js';

const directories = [];
async function fixture(options = {}) { const directory = await mkdtemp(path.join(os.tmpdir(), 'refloom-')); directories.push(directory); const store = new FileWorkspaceStore({ directory, ...options }); await store.initialize(); return store; }
afterEach(async () => Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

function withMedia(id = 'binary-1') {
  let workspace = createProject(createWorkspace(), { id: 'project-1', title: 'Test' });
  workspace = createReference(workspace, { id: 'reference-1', projectId: 'project-1', captureMethod: 'file' });
  return createAsset(workspace, { id: 'asset-1', referenceId: 'reference-1', kind: 'image', locator: `blob:${id}`, mediaType: 'image/png', provenance: { filename: 'one.png' } });
}

test('initializes a validated revision-zero state', async () => {
  const store = await fixture();
  assert.deepEqual(await store.load(), { revision: 0, workspace: createWorkspace() });
});

test('commits atomically and rejects stale writers', async () => {
  const store = await fixture();
  const workspace = createProject(createWorkspace(), { title: 'One' });
  assert.equal((await store.commit(0, workspace)).revision, 1);
  await assert.rejects(store.commit(0, createWorkspace()), RevisionConflictError);
  assert.deepEqual((await store.load()).workspace, workspace);
  assert.equal((await readdir(store.directory)).some(name => name.includes('.tmp-')), false);
});

test('recovers stale locks but bounds waits for live locks', async () => {
  const stale = await fixture({ staleLockMs: 0 });
  await writeFile(stale.lockPath, '{}');
  assert.equal((await stale.commit(0, createWorkspace())).revision, 1);
  const blocked = await fixture({ lockTimeoutMs: 25, staleLockMs: 0 });
  await writeFile(blocked.lockPath, JSON.stringify({ pid: process.pid }));
  await assert.rejects(blocked.commit(0, createWorkspace()), LockTimeoutError);
});

test('cleans orphans deterministically and serves referenced media only', async () => {
  const store = await fixture();
  await writeFile(path.join(store.mediaDirectory, 'orphan'), 'old');
  const workspace = withMedia();
  await store.commit(0, workspace, [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]);
  assert.deepEqual(await store.media('binary-1'), Buffer.from([0]));
  await assert.rejects(store.media('orphan'), /not referenced/i);
  assert.deepEqual((await readdir(store.mediaDirectory)).sort(), ['binary-1']);
  await assert.rejects(store.media('../workspace.json'), /opaque/i);
});

test('backup export and import round trip workspace and media', async () => {
  const source = await fixture();
  const workspace = withMedia();
  await source.commit(0, workspace, [{ id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' }]);
  const target = await fixture();
  const backup = await source.exportBackup();
  assert.deepEqual(JSON.parse(backup).binaries[0], { id: 'binary-1', type: 'image/png', name: 'one.png', data: 'AA==' });
  const result = await target.importBackup(0, backup);
  assert.deepEqual(result.workspace, workspace);
  assert.deepEqual(await target.media('binary-1'), Buffer.from([0]));
});

test('rejects duplicate media additions before replacing content', async () => {
  const store = await fixture();
  await assert.rejects(store.commit(0, withMedia(), [
    { id: 'binary-1', data: 'AA==' },
    { id: 'binary-1', data: 'AQ==' }
  ]), /more than once/);
  assert.equal((await store.load()).revision, 0);
});
