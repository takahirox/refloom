import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MigrationChecksumError, MigrationError } from './persistence-errors.js';

export const MIGRATION_ADVISORY_LOCK = 1380338765;
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_NAME = /^(\d+)_.*\.sql$/;

const bytewiseCompare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

export async function readMigrations(directory = DEFAULT_DIRECTORY, io = { readdir, readFile }) {
  let entries;
  try {
    entries = await io.readdir(directory, { withFileTypes: true });
  } catch (cause) {
    throw new MigrationError('Unable to list PostgreSQL migrations', { directory }, { cause });
  }
  const names = entries
    .filter((entry) => entry.isFile() && MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort(bytewiseCompare);
  const versions = new Set();
  return Promise.all(names.map(async (name) => {
    const version = MIGRATION_NAME.exec(name)[1];
    if (versions.has(version)) {
      throw new MigrationError(`Duplicate migration version ${version}`, { version });
    }
    versions.add(version);
    let sql;
    try {
      sql = await io.readFile(new URL(name, `file://${directory.replace(/\/$/, '')}/`));
    } catch (cause) {
      throw new MigrationError(`Unable to read PostgreSQL migration ${name}`, { name, version }, { cause });
    }
    const bytes = Buffer.isBuffer(sql) ? sql : Buffer.from(sql);
    return {
      version,
      name,
      sql: bytes,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  }));
}

export async function runPostgresMigrations(pool, options = {}) {
  const migrations = options.migrations ?? await readMigrations(options.directory, options.io);
  let client;
  let locked = false;
  try {
    client = await pool.connect();
    await client.query('select pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    locked = true;
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      sha256 text not null,
      applied_at timestamptz not null
    )`);
    const appliedResult = await client.query('select version, sha256 from schema_migrations');
    const applied = new Map(appliedResult.rows.map((row) => [row.version, row.sha256]));
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous !== undefined) {
        if (previous !== migration.sha256) {
          throw new MigrationChecksumError(migration.version, previous, migration.sha256);
        }
        continue;
      }
      await client.query('begin');
      try {
        await client.query(migration.sql.toString('utf8'));
        await client.query(
          'insert into schema_migrations (version, sha256, applied_at) values ($1, $2, now())',
          [migration.version, migration.sha256]
        );
        await client.query('commit');
      } catch (cause) {
        try {
          await client.query('rollback');
        } catch (rollbackCause) {
          throw new MigrationError(`Migration ${migration.version} failed and rollback failed`, {
            version: migration.version, rollbackCause
          }, { cause });
        }
        throw new MigrationError(`Migration ${migration.version} failed`, {
          version: migration.version, name: migration.name
        }, { cause });
      }
    }
    return { applied: migrations.filter((migration) => !applied.has(migration.version)).map(({ version }) => version) };
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause;
    throw new MigrationError('Unable to run PostgreSQL migrations', undefined, { cause });
  } finally {
    if (client) {
      if (locked) {
        try { await client.query('select pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]); } catch {}
      }
      client.release();
    }
  }
}
