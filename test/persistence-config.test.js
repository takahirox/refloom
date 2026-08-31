import test from 'node:test';
import assert from 'node:assert/strict';
import { readPersistenceConfig } from '../src/persistence-config.js';
import {
  MigrationChecksumError,
  PersistenceConfigError,
  PersistenceNotFoundError,
  RevisionConflictError
} from '../src/persistence-errors.js';

const valid = () => ({
  DATABASE_URL: 'postgresql://db.example/refloom',
  REFLOOM_S3_ENDPOINT: 'https://objects.example:9000/base',
  REFLOOM_S3_REGION: 'us-east-1',
  REFLOOM_S3_BUCKET: 'refloom',
  REFLOOM_S3_ACCESS_KEY_ID: 'access',
  REFLOOM_S3_SECRET_ACCESS_KEY: 'secret'
});

test('reads and recursively freezes required persistence configuration', () => {
  const config = readPersistenceConfig(valid());
  assert.deepEqual(config, {
    databaseUrl: 'postgresql://db.example/refloom',
    s3: {
      endpoint: 'https://objects.example:9000/base',
      region: 'us-east-1',
      bucket: 'refloom',
      forcePathStyle: true,
      credentials: { accessKeyId: 'access', secretAccessKey: 'secret' }
    },
    media: {
      orphanGraceMs: 86400000,
      cleanupLimit: 1000,
      cleanupIntervalMs: 3600000
    }
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.s3), true);
  assert.equal(Object.isFrozen(config.s3.credentials), true);
  assert.equal(Object.isFrozen(config.media), true);
});

test('accepts only an exact explicit path-style boolean', () => {
  assert.equal(readPersistenceConfig({ ...valid(), REFLOOM_S3_FORCE_PATH_STYLE: 'false' }).s3.forcePathStyle, false);
  for (const value of ['TRUE', '0', '', true]) {
    assert.throws(() => readPersistenceConfig({ ...valid(), REFLOOM_S3_FORCE_PATH_STYLE: value }), (error) => {
      assert.equal(error.code, 'PERSISTENCE_CONFIG_ERROR');
      assert.deepEqual(error.details, { variable: 'REFLOOM_S3_FORCE_PATH_STYLE' });
      return true;
    });
  }
});

test('reports each missing required variable and rejects unsafe URLs', () => {
  for (const variable of Object.keys(valid())) {
    const env = valid();
    delete env[variable];
    assert.throws(() => readPersistenceConfig(env), (error) => {
      assert.ok(error instanceof PersistenceConfigError);
      assert.deepEqual(error.details, { variable });
      return true;
    });
  }
  for (const patch of [
    { DATABASE_URL: 'https://db.example/refloom' },
    { DATABASE_URL: 'not a url' },
    { REFLOOM_S3_ENDPOINT: '/objects' },
    { REFLOOM_S3_ENDPOINT: 'ftp://objects.example' },
    { REFLOOM_S3_ENDPOINT: 'https://user:pass@objects.example' }
  ]) assert.throws(() => readPersistenceConfig({ ...valid(), ...patch }), PersistenceConfigError);
});

test('reads strict bounded media cleanup configuration', () => {
  const config = readPersistenceConfig({
    ...valid(),
    REFLOOM_MEDIA_ORPHAN_GRACE_MS: '0',
    REFLOOM_MEDIA_CLEANUP_LIMIT: '1',
    REFLOOM_MEDIA_CLEANUP_INTERVAL_MS: '42'
  });
  assert.deepEqual(config.media, {
    orphanGraceMs: 0,
    cleanupLimit: 1,
    cleanupIntervalMs: 42
  });

  for (const [variable, values] of Object.entries({
    REFLOOM_MEDIA_ORPHAN_GRACE_MS: ['-1', '+1', '1.5', '01', '9007199254740992'],
    REFLOOM_MEDIA_CLEANUP_LIMIT: ['0', '1001', '-1', '1e2', ''],
    REFLOOM_MEDIA_CLEANUP_INTERVAL_MS: ['0', '-1', ' 1', 'Infinity']
  })) {
    for (const value of values) {
      assert.throws(() => readPersistenceConfig({ ...valid(), [variable]: value }), (error) => {
        assert.ok(error instanceof PersistenceConfigError);
        assert.deepEqual(error.details, { variable });
        assert.match(error.message, new RegExp(variable));
        if (value !== '') assert.equal(error.message.includes(value), false);
        return true;
      });
    }
  }
});

test('persistence errors expose stable actionable codes, details, and causes', () => {
  const cause = new Error('root');
  const missing = new PersistenceNotFoundError('media', 'm1', { cause });
  assert.deepEqual([missing.code, missing.details, missing.cause], ['PERSISTENCE_NOT_FOUND', { resource: 'media', id: 'm1' }, cause]);
  const conflict = new RevisionConflictError(2, 3);
  assert.deepEqual([conflict.code, conflict.details], ['REVISION_CONFLICT', { expectedRevision: 2, actualRevision: 3 }]);
  const checksum = new MigrationChecksumError('0001', 'old', 'new', { cause });
  assert.deepEqual([checksum.code, checksum.details, checksum.cause], [
    'MIGRATION_CHECKSUM_MISMATCH', { version: '0001', expectedSha256: 'old', actualSha256: 'new' }, cause
  ]);
});
