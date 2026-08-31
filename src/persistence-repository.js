const METHODS = Object.freeze([
  'initialize',
  'readiness',
  'load',
  'commit',
  'mediaInfo',
  'exportBackup',
  'importBackup',
  'cleanupMedia',
  'close'
]);

export const PERSISTENCE_REPOSITORY_METHODS = METHODS;

export function validatePersistenceRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('Persistence repository must be an object');
  }
  const missing = METHODS.filter(method => typeof repository[method] !== 'function');
  if (missing.length) {
    throw new TypeError(`Persistence repository is missing: ${missing.join(', ')}`);
  }
  return repository;
}

// Behavioral interface only. Concrete repositories implement every operation.
export class PersistenceRepository {
  initialize() { return this.#required('initialize'); }
  readiness() { return this.#required('readiness'); }
  load() { return this.#required('load'); }
  commit(_expectedRevision, _workspace, _additions) { return this.#required('commit'); }
  mediaInfo(_id) { return this.#required('mediaInfo'); }
  exportBackup() { return this.#required('exportBackup'); }
  importBackup(_expectedRevision, _text) { return this.#required('importBackup'); }
  cleanupMedia(_options) { return this.#required('cleanupMedia'); }
  close() { return this.#required('close'); }

  #required(method) {
    throw new TypeError(`PersistenceRepository.${method}() must be implemented`);
  }
}
