export class PersistenceError extends Error {
  constructor(message, { code = 'PERSISTENCE_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class PersistenceConfigError extends PersistenceError {
  constructor(message, details, options = {}) {
    super(message, { code: 'PERSISTENCE_CONFIG_ERROR', details, cause: options.cause });
  }
}

export class PersistenceNotFoundError extends PersistenceError {
  constructor(resource, id, options = {}) {
    super(`${resource} not found: ${id}`, {
      code: 'PERSISTENCE_NOT_FOUND', details: { resource, id }, cause: options.cause
    });
  }
}

export class RevisionConflictError extends PersistenceError {
  constructor(expectedRevision, actualRevision, options = {}) {
    super(`Revision conflict: expected ${expectedRevision}, found ${actualRevision}`, {
      code: 'REVISION_CONFLICT',
      details: { expectedRevision, actualRevision },
      cause: options.cause
    });
  }
}

export class MigrationError extends PersistenceError {
  constructor(message, details, options = {}) {
    super(message, { code: 'MIGRATION_ERROR', details, cause: options.cause });
  }
}

export class MigrationChecksumError extends MigrationError {
  constructor(version, expectedSha256, actualSha256, options = {}) {
    super(`Migration ${version} checksum does not match the applied migration`, {
      version, expectedSha256, actualSha256
    }, options);
    this.code = 'MIGRATION_CHECKSUM_MISMATCH';
  }
}
