import { S3Client } from '@aws-sdk/client-s3';
import pg from 'pg';
import { readPersistenceConfig } from './persistence-config.js';
import { validatePersistenceRepository } from './persistence-repository.js';
import { PostgresWorkspaceRepository } from './postgres-workspace-repository.js';
import { S3MediaStore } from './s3-media-store.js';

const { Pool } = pg;

const POOL_DEFAULTS = Object.freeze({
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

export function createPersistenceRepository(options = {}) {
  const {
    env = process.env,
    config: injectedConfig,
    PoolClass = Pool,
    S3ClientClass = S3Client,
    MediaStoreClass = S3MediaStore,
    RepositoryClass = PostgresWorkspaceRepository
  } = options;
  const config = injectedConfig ?? readPersistenceConfig(env);

  try {
    const pool = new PoolClass({
      connectionString: config.databaseUrl,
      ...POOL_DEFAULTS
    });
    const client = new S3ClientClass({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: config.s3.credentials,
      followRegionRedirects: false,
      maxAttempts: 3
    });
    const mediaStore = new MediaStoreClass({
      client,
      bucket: config.s3.bucket,
      orphanGraceMs: config.media.orphanGraceMs,
      cleanupLimit: config.media.cleanupLimit
    });
    const repository = validatePersistenceRepository(new RepositoryClass({
      pool,
      mediaStore
    }));
    return Object.freeze({
      repository,
      cleanupIntervalMs: config.media.cleanupIntervalMs
    });
  } catch {
    throw new TypeError('Unable to construct persistence repository');
  }
}
