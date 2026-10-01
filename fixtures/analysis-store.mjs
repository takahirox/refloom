import { createAsset, createProject, createReference, createWorkspace, importWorkspace } from '../src/domain.js';
import { RevisionConflictError } from '../src/persistence-errors.js';
import { decodeBackup, encodeBackup } from '../src/storage.js';
import { png } from './analysis-profile.mjs';
export class MemoryStore {
  constructor() {
    this.revision = 0;
    let w = createProject(createWorkspace(), { id: 'p', title: 'Study' });
    w = createReference(w, { id: 'r', projectId: 'p', captureMethod: 'file' });
    this.workspace = createAsset(w, { id: 'a', referenceId: 'r', kind: 'image', mediaType: 'image/png', locator: 'blob:b' });
    this.conflicts = 0;
  }
  async initialize() {}
  async readiness() { return true; }
  async cleanupMedia() {}
  async close() {}
  async load() { return { revision: this.revision, workspace: structuredClone(this.workspace) }; }
  async commit(revision, workspace) {
    if (this.conflicts > 0) { this.conflicts--; this.revision++; }
    if (revision !== this.revision) throw new RevisionConflictError(revision, this.revision);
    this.workspace = importWorkspace(workspace); this.revision++;
    return this.load();
  }
  async mediaInfo() { return { contents: png, mediaType: 'image/png' }; }
  async exportBackup() { return encodeBackup(this.workspace, [{ id: 'b', type: 'image/png', name: 'test.png', data: png.toString('base64') }]); }
  async importBackup(revision, text) { return this.commit(revision, decodeBackup(text).workspace); }
}
