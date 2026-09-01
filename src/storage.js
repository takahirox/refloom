import { createWorkspace, importWorkspace, validateWorkspace } from './domain.js';

export const BLOB_PREFIX = 'blob:';
export const BACKUP_FORMAT = 'refloom.workspace-backup';
export const BACKUP_VERSION = 2;

export class RevisionConflictError extends Error {
  constructor(message = 'This workspace changed in another process. The latest version has been reloaded; review your change and try again.') { super(message); this.name = 'RevisionConflictError'; }
}

export class StorageUnavailableError extends Error {
  constructor(message = 'The Refloom workspace service is unavailable. Check the server connection, then reload.') {
    super(message);
    this.name = 'StorageUnavailableError';
  }
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
    const keys = file && Object.keys(file);
    if (!keys || keys.length !== BINARY_KEYS.length || !BINARY_KEYS.every(key => keys.includes(key))) throw new TypeError('Backup contains corrupt binary record keys');
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

export class WorkspaceRepository {
  constructor(fetcher = globalThis.fetch?.bind(globalThis)) { this.fetcher = fetcher; this.revision = undefined; }

  async #request(path, options = {}, acceptedStatuses = []) {
    if (!this.fetcher) throw new StorageUnavailableError();
    let response;
    try { response = await this.fetcher(path, options); }
    catch (error) { throw new StorageUnavailableError(`Could not reach the Refloom workspace service: ${error.message}`); }
    if (response.status === 409 && !acceptedStatuses.includes(409)) {
      throw new RevisionConflictError();
    }
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      let detail;
      try { detail = (await response.json()).error; } catch { detail = response.statusText; }
      throw new StorageUnavailableError(detail || `Workspace service returned HTTP ${response.status}`);
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
    }, [400, 409, 429, 502]);
    return response.json();
  }

  async captureStatus(referenceId) {
    return (await this.#request(
      `/api/captures/${encodeURIComponent(referenceId)}/status`
    )).json();
  }

  async cancelCapture(referenceId) {
    return (await this.#request(
      `/api/captures/${encodeURIComponent(referenceId)}/status`, { method: 'DELETE' }
    )).json();
  }

  async mutate(workspace, additions = [], options = {}) {
    validateWorkspace(workspace);
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => key !== 'capture' && key !== 'captureSettings')
      || (options.capture !== undefined && typeof options.capture !== 'boolean')) {
      throw new TypeError('Workspace mutation options are invalid');
    }
    const binaries = [];
    for (const item of additions) {
      if (!item || typeof item.id !== 'string' || !(item.blob instanceof Blob)) throw new TypeError('Binary addition requires an id and Blob');
      binaries.push({ id: item.id, name: item.name || '', type: item.blob.type, data: await blobToBase64(item.blob) });
    }
    try {
      const value = await (await this.#request('/api/workspace', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: this.revision, workspace, binaries, ...options }) })).json();
      this.revision = value.revision;
      return value;
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

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read binary'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.readAsDataURL(blob);
  });
}
