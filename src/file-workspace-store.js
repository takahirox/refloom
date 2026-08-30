import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace, importWorkspace } from './domain.js';
import { blobIdFromLocator, decodeBackup, encodeBackup, referencedBlobIds } from './storage.js';

export const STATE_FORMAT = 'refloom.workspace-state';
export const STATE_VERSION = 1;
export const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const DEFAULT_LIMITS = Object.freeze({ mediaBytes: 25 * 1024 * 1024, workspaceBytes: 5 * 1024 * 1024, totalBytes: 250 * 1024 * 1024 });

export class StoreError extends Error {
  constructor(code, message, options) { super(message, options); this.name = this.constructor.name; this.code = code; }
}
export class RevisionConflictError extends StoreError {
  constructor(expected, actual) { super('REVISION_CONFLICT', `Workspace revision ${expected} is stale; current revision is ${actual}`); this.expected = expected; this.actual = actual; }
}
export class LockTimeoutError extends StoreError {
  constructor() { super('LOCK_TIMEOUT', 'Timed out waiting for the workspace lock; retry the operation'); }
}
export class MediaError extends StoreError {}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const envelope = (revision, workspace) => ({ format: STATE_FORMAT, version: STATE_VERSION, revision, workspace });
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));

function mediaId(id) {
  if (!MEDIA_ID.test(id)) throw new MediaError('INVALID_MEDIA_ID', 'Media identifier must be an opaque URL-safe identifier');
  return id;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new MediaError('INVALID_MEDIA', 'Media data must be canonical base64');
  return Buffer.from(value, 'base64');
}

export class FileWorkspaceStore {
  constructor(options = {}) {
    this.directory = path.resolve(options.directory ?? 'data');
    this.statePath = path.join(this.directory, 'workspace.json');
    this.mediaDirectory = path.join(this.directory, 'media');
    this.lockPath = path.join(this.directory, '.workspace.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2000;
    this.staleLockMs = options.staleLockMs ?? 30_000;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.mediaDirectory, { recursive: true, mode: 0o700 });
    try { await this.#read(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#atomicJson(this.statePath, envelope(0, createWorkspace()));
    }
    return this.load();
  }

  async #read() {
    let value;
    try { value = JSON.parse(await readFile(this.statePath, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw error;
      throw new StoreError('CORRUPT_STATE', 'Stored workspace envelope is not valid JSON', { cause: error });
    }
    if (value?.format !== STATE_FORMAT || value.version !== STATE_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new StoreError('CORRUPT_STATE', 'Stored workspace envelope is corrupt or unsupported');
    return { revision: value.revision, workspace: importWorkspace(value.workspace) };
  }

  async load() { await this.initializeDirectories(); return this.#read(); }
  async initializeDirectories() { await mkdir(this.mediaDirectory, { recursive: true, mode: 0o700 }); }

  async #atomicJson(filename, value) {
    const temporary = `${filename}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, filename);
      const directory = await open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #ownerIsAlive() {
    try {
      const value = JSON.parse(await readFile(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(value?.pid) || value.pid <= 0) return false;
      try { process.kill(value.pid, 0); return true; }
      catch (error) { return error.code === 'EPERM'; }
    } catch { return false; }
  }

  async #lock() {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return async () => { await handle.close(); await rm(this.lockPath, { force: true }); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(this.lockPath)).mtimeMs > this.staleLockMs && !await this.#ownerIsAlive()) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch (check) { if (check.code === 'ENOENT') continue; throw check; }
        if (Date.now() >= deadline) throw new LockTimeoutError();
        await delay(20);
      }
    }
  }

  #serialized(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async commit(expectedRevision, workspace, additions = []) {
    return this.#serialized(async () => {
      const release = await this.#lock();
      const staged = [];
      try {
        const current = await this.#read();
        if (expectedRevision !== current.revision) throw new RevisionConflictError(expectedRevision, current.revision);
        const validated = importWorkspace(workspace);
        if (jsonBytes(validated) > this.limits.workspaceBytes) throw new StoreError('WORKSPACE_TOO_LARGE', 'Workspace exceeds the configured size limit');
        const required = referencedBlobIds(validated);
        const additionIds = new Set();
        let addedBytes = 0;
        for (const item of additions) {
          const id = mediaId(item?.id);
          if (additionIds.has(id)) throw new MediaError('DUPLICATE_MEDIA', `Media ${id} is included more than once`);
          additionIds.add(id);
          if (!required.has(id)) throw new MediaError('ORPHAN_MEDIA', `Media ${id} is not referenced by the workspace`);
          const data = decodeBase64(item.data);
          if (data.length > this.limits.mediaBytes) throw new MediaError('MEDIA_TOO_LARGE', `Media ${id} exceeds the configured size limit`);
          addedBytes += data.length;
          const temporary = path.join(this.mediaDirectory, `.tmp-${process.pid}-${crypto.randomUUID()}`);
          await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
          staged.push([temporary, path.join(this.mediaDirectory, id)]);
        }
        const names = await readdir(this.mediaDirectory);
        let retainedBytes = 0;
        for (const id of required) if (!additionIds.has(id)) {
          mediaId(id);
          try { retainedBytes += (await stat(path.join(this.mediaDirectory, id))).size; }
          catch (error) { if (error.code === 'ENOENT') throw new MediaError('MISSING_MEDIA', `Referenced media ${id} is missing`); throw error; }
        }
        if (retainedBytes + addedBytes > this.limits.totalBytes) throw new MediaError('MEDIA_LIMIT', 'Workspace media exceeds the configured total size limit');
        for (const [temporary, destination] of staged) await rename(temporary, destination);
        const next = envelope(current.revision + 1, validated);
        await this.#atomicJson(this.statePath, next);
        for (const name of names.sort()) if (MEDIA_ID.test(name) && !required.has(name)) await rm(path.join(this.mediaDirectory, name), { force: true });
        return { revision: next.revision, workspace: validated };
      } finally {
        for (const [temporary] of staged) await rm(temporary, { force: true });
        await release();
      }
    });
  }

  async media(id) {
    return (await this.mediaInfo(id)).contents;
  }

  async mediaInfo(id) {
    mediaId(id);
    const current = await this.#read();
    if (!referencedBlobIds(current.workspace).has(id)) throw new MediaError('MEDIA_NOT_REFERENCED', 'Media is not referenced by the authoritative workspace');
    const asset = current.workspace.assets.find(item => blobIdFromLocator(item.locator) === id);
    const mediaType = typeof asset?.mediaType === 'string' && /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(asset.mediaType)
      ? asset.mediaType
      : 'application/octet-stream';
    try {
      return {
        contents: await readFile(path.join(this.mediaDirectory, id)),
        mediaType,
        name: typeof asset?.provenance?.filename === 'string' ? asset.provenance.filename : ''
      };
    }
    catch (error) { if (error.code === 'ENOENT') throw new MediaError('MISSING_MEDIA', `Referenced media ${id} is missing`); throw error; }
  }

  async exportBackup() {
    const current = await this.#read();
    const binaries = [];
    for (const id of [...referencedBlobIds(current.workspace)].sort()) {
      const media = await this.mediaInfo(id);
      binaries.push({ id, type: media.mediaType === 'application/octet-stream' ? '' : media.mediaType, name: media.name, data: media.contents.toString('base64') });
    }
    return encodeBackup(current.workspace, binaries);
  }

  async importBackup(expectedRevision, text) {
    const backup = decodeBackup(text);
    return this.commit(expectedRevision, backup.workspace, backup.binaries);
  }
}
