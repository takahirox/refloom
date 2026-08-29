import { createWorkspace, importWorkspace, validateWorkspace } from './domain.js';

export const DATABASE_NAME = 'refloom';
export const DATABASE_VERSION = 1;
export const WORKSPACE_KEY = 'current';
export const BLOB_PREFIX = 'blob:';
export const BACKUP_FORMAT = 'refloom.workspace-backup';
export const BACKUP_VERSION = 1;

export class StorageUnavailableError extends Error {
  constructor(message = 'Local storage is unavailable. Enable IndexedDB or use a browser profile that permits site data, then reload.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export function serializeWorkspace(workspace) {
  validateWorkspace(workspace);
  return JSON.stringify(workspace);
}

export function deserializeWorkspace(value) {
  if (typeof value !== 'string') throw new TypeError('Stored workspace must be JSON text');
  return importWorkspace(value);
}

export function blobIdFromLocator(locator) {
  return typeof locator === 'string' && locator.startsWith(BLOB_PREFIX) ? locator.slice(BLOB_PREFIX.length) : null;
}

export function referencedBlobIds(workspace) {
  validateWorkspace(workspace);
  return new Set(workspace.assets.map(asset => blobIdFromLocator(asset.locator)).filter(Boolean));
}

export function encodeBackup(workspace, binaries = []) {
  validateWorkspace(workspace);
  const files = binaries.map(file => {
    if (!file || typeof file.id !== 'string' || typeof file.type !== 'string' || typeof file.data !== 'string') throw new TypeError('Invalid backup binary');
    return { id: file.id, type: file.type, name: typeof file.name === 'string' ? file.name : '', data: file.data };
  });
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, workspace, binaries: files }, null, 2);
}

export function decodeBackup(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new TypeError('Backup is not valid JSON'); }
  if (!value || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION || !Array.isArray(value.binaries)) throw new TypeError('Unsupported Refloom backup');
  const workspace = importWorkspace(value.workspace);
  const required = referencedBlobIds(workspace);
  const seen = new Set();
  for (const file of value.binaries) {
    if (!file || typeof file.id !== 'string' || typeof file.type !== 'string' || typeof file.data !== 'string' || seen.has(file.id)) throw new TypeError('Backup contains corrupt binary records');
    seen.add(file.id);
  }
  for (const id of required) if (!seen.has(id)) throw new TypeError(`Backup is missing binary ${id}`);
  return { workspace, binaries: value.binaries.filter(file => required.has(file.id)) };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted'));
  });
}

export class WorkspaceRepository {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.db = null; }

  async open() {
    if (!this.indexedDB) throw new StorageUnavailableError();
    try {
      const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('workspace')) db.createObjectStore('workspace');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      request.onblocked = () => request.transaction?.abort();
      this.db = await requestResult(request);
      this.db.onversionchange = () => this.db.close();
      return this;
    } catch (error) {
      throw new StorageUnavailableError(`Refloom could not open local storage: ${error.message}`);
    }
  }

  async load() {
    const tx = this.db.transaction('workspace', 'readonly');
    const stored = await requestResult(tx.objectStore('workspace').get(WORKSPACE_KEY));
    await transactionDone(tx);
    if (stored === undefined) return createWorkspace();
    try { return deserializeWorkspace(stored); }
    catch (error) { throw new StorageUnavailableError(`Stored workspace is corrupt or unsupported: ${error.message}. Import a valid backup or clear this site's data.`); }
  }

  async mutate(workspace, additions = []) {
    validateWorkspace(workspace);
    const tx = this.db.transaction(['workspace', 'blobs'], 'readwrite');
    const workspaceStore = tx.objectStore('workspace');
    const blobStore = tx.objectStore('blobs');
    workspaceStore.put(serializeWorkspace(workspace), WORKSPACE_KEY);
    for (const item of additions) {
      if (!item || typeof item.id !== 'string' || !(item.blob instanceof Blob)) throw new TypeError('Binary addition requires an id and Blob');
      blobStore.put({ blob: item.blob, name: item.name || '', type: item.blob.type }, item.id);
    }
    const keep = referencedBlobIds(workspace);
    const keys = await requestResult(blobStore.getAllKeys());
    for (const key of keys) if (!keep.has(String(key))) blobStore.delete(key);
    await transactionDone(tx);
  }

  async blob(id) {
    const tx = this.db.transaction('blobs', 'readonly');
    const record = await requestResult(tx.objectStore('blobs').get(id));
    await transactionDone(tx);
    if (!record?.blob) throw new StorageUnavailableError(`Local binary ${id} is missing. Restore a backup or remove the affected reference.`);
    return record.blob;
  }

  async exportBackup(workspace) {
    const required = referencedBlobIds(workspace);
    const binaries = [];
    for (const id of required) {
      const blob = await this.blob(id);
      binaries.push({ id, type: blob.type, name: '', data: await blobToBase64(blob) });
    }
    return encodeBackup(workspace, binaries);
  }

  async importBackup(text) {
    const backup = decodeBackup(text);
    const additions = backup.binaries.map(file => ({ id: file.id, name: file.name, blob: base64ToBlob(file.data, file.type) }));
    await this.mutate(backup.workspace, additions);
    return backup.workspace;
  }

  async reset() {
    const workspace = createWorkspace();
    await this.mutate(workspace);
    return workspace;
  }

  close() { this.db?.close(); }
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read binary'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(data, type) {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  } catch { throw new TypeError('Backup contains invalid binary data'); }
}
