import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistenceRepository } from '../src/create-persistence-repository.js';

const valid = () => ({
  DATABASE_URL: 'postgresql://db.example/refloom',
  REFLOOM_S3_ENDPOINT: 'https://objects.example:9000/base',
  REFLOOM_S3_REGION: 'us-east-1',
  REFLOOM_S3_BUCKET: 'refloom',
  REFLOOM_S3_ACCESS_KEY_ID: 'access',
  REFLOOM_S3_SECRET_ACCESS_KEY: 'secret'
});

function fakes() {
  const calls = [];
  class FakePool {
    constructor(options) { this.options = options; calls.push(['pool', this, options]); }
    query() {}
    connect() {}
    end() {}
  }
  class FakeS3Client {
    constructor(options) { this.options = options; calls.push(['s3', this, options]); }
  }
  class FakeMediaStore {
    constructor(options) {
      this.options = options;
      this.limits = {};
      calls.push(['media', this, options]);
    }
    readiness() {}
    putAdditions() {}
    get() {}
    cleanupMedia() {}
  }
  class FakeRepository {
    constructor(options) { this.options = options; calls.push(['repository', this, options]); }
    initialize() {}
    readiness() {}
    load() {}
    commit() {}
    mediaInfo() {}
    exportBackup() {}
    importBackup() {}
    cleanupMedia() {}
    close() {}
  }
  return {
    calls,
    classes: {
      PoolClass: FakePool,
      S3ClientClass: FakeS3Client,
      MediaStoreClass: FakeMediaStore,
      RepositoryClass: FakeRepository
    }
  };
}

test('constructs one bounded shared object graph without initialization or network calls', () => {
  const { calls, classes } = fakes();
  const result = createPersistenceRepository({ env: valid(), ...classes });

  assert.deepEqual(calls.map(call => call[0]), ['pool', 's3', 'media', 'repository']);
  assert.deepEqual(calls[0][2], {
    connectionString: 'postgresql://db.example/refloom',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
  assert.deepEqual(calls[1][2], {
    endpoint: 'https://objects.example:9000/base',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'access', secretAccessKey: 'secret' },
    followRegionRedirects: false,
    maxAttempts: 3
  });
  assert.deepEqual(calls[2][2], {
    client: calls[1][1],
    bucket: 'refloom',
    orphanGraceMs: 86400000,
    cleanupLimit: 1000
  });
  assert.deepEqual(calls[3][2], {
    pool: calls[0][1],
    mediaStore: calls[2][1]
  });
  assert.equal(result.repository, calls[3][1]);
  assert.equal(result.cleanupIntervalMs, 3600000);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.some(call => call[0] === 'initialize'), false);
});

test('supports injected configuration and cleanup values for fake-only construction', () => {
  const { calls, classes } = fakes();
  const config = Object.freeze({
    databaseUrl: 'postgresql://injected.example/refloom',
    s3: Object.freeze({
      endpoint: 'https://injected.example',
      region: 'eu-west-1',
      bucket: 'injected',
      forcePathStyle: false,
      credentials: Object.freeze({ accessKeyId: 'injected-access', secretAccessKey: 'injected-secret' })
    }),
    media: Object.freeze({ orphanGraceMs: 9, cleanupLimit: 8, cleanupIntervalMs: 7 })
  });
  const result = createPersistenceRepository({
    env: new Proxy({}, { get() { throw new Error('environment was read'); } }),
    config,
    ...classes
  });

  assert.equal(calls[0][2].connectionString, config.databaseUrl);
  assert.equal(calls[1][2].credentials, config.s3.credentials);
  assert.equal(calls[2][2].orphanGraceMs, 9);
  assert.equal(calls[2][2].cleanupLimit, 8);
  assert.equal(result.cleanupIntervalMs, 7);
});

test('validates the repository contract and redacts constructor failures', () => {
  const { classes } = fakes();
  class InvalidRepository {}
  assert.throws(() => createPersistenceRepository({
    env: valid(),
    ...classes,
    RepositoryClass: InvalidRepository
  }), /Unable to construct persistence repository/);

  const secrets = ['postgresql://private-user:private-password@db/refloom', 'private-secret'];
  class FailingClient {
    constructor(options) { throw new Error(JSON.stringify(options)); }
  }
  let failure;
  try {
    createPersistenceRepository({
      env: {
        ...valid(),
        DATABASE_URL: secrets[0],
        REFLOOM_S3_SECRET_ACCESS_KEY: secrets[1]
      },
      ...classes,
      S3ClientClass: FailingClient
    });
  } catch (error) { failure = error; }
  assert.ok(failure instanceof TypeError);
  assert.equal(failure.cause, undefined);
  for (const secret of secrets) assert.equal(String(failure).includes(secret), false);
});
