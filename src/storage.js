import { createWorkspace, importWorkspace, validateWorkspace } from './domain.js';

export const DATABASE_NAME = 'refloom';
export const DATABASE_VERSION = 1;
export const WORKSPACE_KEY = 'current';
export const BLOB_PREFIX = 'blob:';
export const BACKUP_FORMAT = 'refloom.workspace-backup';
export const BACKUP_VERSION = 2;

export class RevisionConflictError extends Error {
  constructor(message = 'This workspace changed in another process. The latest version has been reloaded; review your change and try again.') { super(message); this.name = 'RevisionConflictError'; }
}

export class StorageUnavailableError extends Error {
  constructor(message = 'The local Refloom companion is unavailable. Start the localhost server, then reload.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export function isEmptyWorkspace(workspace) {
  validateWorkspace(workspace);
  return ['projects', 'references', 'assets', 'targets', 'moments', 'selections', 'boards', 'signals'].every(name => workspace[name].length === 0);
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

const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const BINARY_KEYS = ['id', 'type', 'name', 'size', 'sha256', 'data'];
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function decodeCanonicalBase64(data) {
  if (typeof data !== 'string' || !CANONICAL_BASE64.test(data)) throw new TypeError('Backup contains noncanonical base64 data');
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits));

function sha256(bytes) {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(bytes);
  message[bytes.length] = 0x80;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 4, bytes.length * 8, false);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let offset = 0; offset < message.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15];
      const b = words[index - 2];
      words[index] = (words[index - 16] + (rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3)) + words[index - 7] + (rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const first = (h + (rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const second = ((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [a, b, c, d, e, f, g, h] = [(first + second) >>> 0, a, b, c, (d + first) >>> 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index] + value) >>> 0; });
  }
  return hash.map(value => value.toString(16).padStart(8, '0')).join('');
}

function binaryRecord(file) {
  if (!file || !MEDIA_ID.test(file.id) || typeof file.type !== 'string' || typeof file.name !== 'string') throw new TypeError('Invalid backup binary');
  const bytes = decodeCanonicalBase64(file.data);
  if (!Number.isSafeInteger(bytes.length) || bytes.length > MAX_MEDIA_BYTES) throw new TypeError(`Backup binary ${file.id} has an unsafe size`);
  const digest = sha256(bytes);
  if (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size !== bytes.length)) throw new TypeError(`Backup binary ${file.id} has an inconsistent size`);
  if (file.sha256 !== undefined && (!LOWERCASE_SHA256.test(file.sha256) || file.sha256 !== digest)) throw new TypeError(`Backup binary ${file.id} has an inconsistent SHA-256`);
  return { id: file.id, type: file.type, name: file.name, size: bytes.length, sha256: digest, data: file.data };
}

function clonedWorkspace(workspace) {
  const clone = importWorkspace(workspace);
  for (const id of referencedBlobIds(clone)) if (!MEDIA_ID.test(id)) throw new TypeError(`Invalid backup binary id ${id}`);
  return clone;
}

export function encodeBackup(workspace, binaries = []) {
  const clone = clonedWorkspace(workspace);
  const required = referencedBlobIds(clone);
  const seen = new Set();
  let total = 0;
  const files = binaries.map(file => {
    const record = binaryRecord(file);
    if (seen.has(record.id)) throw new TypeError(`Backup binary ${record.id} is duplicated`);
    seen.add(record.id);
    if (!required.has(record.id)) throw new TypeError(`Backup binary ${record.id} is orphaned`);
    total += record.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) throw new TypeError('Backup binaries exceed the configured total size limit');
    return record;
  }).sort((left, right) => left.id.localeCompare(right.id));
  for (const id of required) if (!seen.has(id)) throw new TypeError(`Backup is missing binary ${id}`);
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, workspace: clone, binaries: files }, null, 2);
}

export function decodeBackup(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new TypeError('Backup is not valid JSON'); }
  if (!value || value.version === 1 || value.version !== BACKUP_VERSION) throw new TypeError('Unsupported Refloom backup version');
  if (value.format !== BACKUP_FORMAT || !Array.isArray(value.binaries)) throw new TypeError('Unsupported Refloom backup');
  const workspace = clonedWorkspace(value.workspace);
  const required = referencedBlobIds(workspace);
  const seen = new Set();
  const binaries = [];
  let total = 0;
  for (const file of value.binaries) {
    if (!file || Object.keys(file).length !== BINARY_KEYS.length || !BINARY_KEYS.every((key, index) => Object.keys(file)[index] === key)) throw new TypeError('Backup contains corrupt binary record keys');
    const record = binaryRecord(file);
    if (seen.has(record.id)) throw new TypeError(`Backup binary ${record.id} is duplicated`);
    seen.add(record.id);
    if (!required.has(record.id)) throw new TypeError(`Backup binary ${record.id} is orphaned`);
    total += record.size;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) throw new TypeError('Backup binaries exceed the configured total size limit');
    binaries.push(record);
  }
  for (const id of required) if (!seen.has(id)) throw new TypeError(`Backup is missing binary ${id}`);
  binaries.sort((left, right) => left.id.localeCompare(right.id));
  return { workspace, binaries };
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
  constructor(fetcher = globalThis.fetch?.bind(globalThis)) { this.fetcher = fetcher; this.revision = undefined; }

  async #request(path, options = {}) {
    if (!this.fetcher) throw new StorageUnavailableError();
    let response;
    try { response = await this.fetcher(path, options); }
    catch (error) { throw new StorageUnavailableError(`Could not reach the local Refloom companion: ${error.message}`); }
    if (response.status === 409) throw new RevisionConflictError();
    if (!response.ok) {
      let detail;
      try { detail = (await response.json()).error; } catch { detail = response.statusText; }
      throw new StorageUnavailableError(detail || `Local companion returned HTTP ${response.status}`);
    }
    return response;
  }

  async open() { return this; }

  async load() {
    const value = await (await this.#request('/api/workspace')).json();
    this.revision = value.revision;
    return importWorkspace(value.workspace);
  }

  async captureWebsite(referenceId, settings = {}) {
    const response = await this.#request('/api/captures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId, settings })
    });
    return response.json();
  }

  async mutate(workspace, additions = []) {
    validateWorkspace(workspace);
    const binaries = [];
    for (const item of additions) {
      if (!item || typeof item.id !== 'string' || !(item.blob instanceof Blob)) throw new TypeError('Binary addition requires an id and Blob');
      binaries.push({ id: item.id, name: item.name || '', type: item.blob.type, data: await blobToBase64(item.blob) });
    }
    try {
      const value = await (await this.#request('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.revision, workspace, binaries }) })).json();
      this.revision = value.revision;
    } catch (error) {
      if (error instanceof RevisionConflictError) await this.load();
      throw error;
    }
  }

  async blob(id) { return (await this.#request(`/api/media/${encodeURIComponent(id)}`)).blob(); }
  async exportBackup() { return (await this.#request('/api/backup')).text(); }
  async importBackup(text) {
    const value = await (await this.#request('/api/backup', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.revision, backup: JSON.parse(text) }) })).json();
    this.revision = value.revision;
    return importWorkspace(value.workspace);
  }
  async reset() { const workspace = createWorkspace(); await this.mutate(workspace); return workspace; }
  close() {}
}

export class LegacyIndexedDBRepository {
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
  async migrationPayload() {
    const workspace = await this.load();
    const binaries = [];
    for (const id of referencedBlobIds(workspace)) {
      const tx = this.db.transaction('blobs', 'readonly');
      const record = await requestResult(tx.objectStore('blobs').get(id));
      await transactionDone(tx);
      if (!record?.blob) throw new StorageUnavailableError(`Legacy binary ${id} is missing; restore a backup before migration.`);
      binaries.push({ id, name: record.name || '', blob: record.blob });
    }
    return { workspace, binaries };
  }
  close() { this.db?.close(); }
}

export async function readLegacyMigration(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return null;
  const legacy = new LegacyIndexedDBRepository(indexedDB);
  try { await legacy.open(); const payload = await legacy.migrationPayload(); return isEmptyWorkspace(payload.workspace) ? null : payload; }
  catch { return null; }
  finally { legacy.close(); }
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
