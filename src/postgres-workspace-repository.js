import { importWorkspace, ValidationError } from './domain.js';
import {
  MediaPersistenceError,
  PersistenceError,
  PersistenceNotFoundError,
  RevisionConflictError
} from './persistence-errors.js';
import { runPostgresMigrations } from './postgres-migrations.js';
import {
  DELETE_ORDER,
  INSERT_ORDER,
  INSERT_SPECIFICATIONS,
  rowsToWorkspace,
  workspaceToRows
} from './postgres-workspace-mapper.js';
import { PersistenceRepository } from './persistence-repository.js';
import { decodeBackup, encodeBackup, referencedBlobIds } from './storage.js';

const SELECTS = Object.freeze({
  projects: 'select * from projects',
  references: 'select * from "references"',
  assets: 'select * from assets',
  targets: 'select * from targets',
  moments: 'select * from moments',
  selections: 'select * from selections',
  boards: 'select * from boards',
  board_selections: 'select * from board_selections order by board_id, position',
  signals: 'select * from signals'
});

const RETAINED_MEDIA = `select id, object_key, sha256, size_bytes, media_type, original_name
  from media_objects where id = any($1::text[])`;
const VALID_SHA256 = /^[0-9a-f]{64}$/;
const REFERENCED_MEDIA = `select m.id, m.sha256, m.size_bytes, m.media_type, m.original_name
  from media_objects m
  where m.id = $1
    and exists (select 1 from assets a where a.locator = 'blob:' || m.id)`;
const tableName = table => table === 'references' ? '"references"' : table;

function revision(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new PersistenceError('Stored workspace revision is invalid');
  }
  return number;
}

function safe(error, operation) {
  if (error instanceof PersistenceError || error instanceof ValidationError
    || error instanceof MediaPersistenceError) throw error;
  throw new PersistenceError(`PostgreSQL workspace ${operation} failed`, { cause: error });
}

async function rowSets(connection) {
  const result = {};
  for (const table of INSERT_ORDER) result[table] = (await connection.query(SELECTS[table])).rows;
  return result;
}

async function loaded(connection, locked = false) {
  const state = await connection.query(
    `select revision from workspace_state where singleton = true${locked ? ' for update' : ''}`
  );
  if (state.rows.length !== 1) throw new PersistenceError('Workspace state is unavailable');
  return { revision: revision(state.rows[0].revision), workspace: rowsToWorkspace(await rowSets(connection)) };
}

export class PostgresWorkspaceRepository extends PersistenceRepository {
  constructor({ pool, mediaStore, migrations, limits } = {}) {
    super();
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
      || typeof pool.end !== 'function') throw new TypeError('PostgreSQL pool is required');
    if (!mediaStore || typeof mediaStore.readiness !== 'function'
      || typeof mediaStore.putAdditions !== 'function'
      || typeof mediaStore.get !== 'function'
      || typeof mediaStore.cleanupMedia !== 'function') throw new TypeError('Media store is required');
    this.pool = pool;
    this.mediaStore = mediaStore;
    this.migrations = migrations;
    this.limits = { ...mediaStore.limits, ...limits };
    this.closed = false;
  }

  async initialize() {
    try {
      await runPostgresMigrations(this.pool,
        this.migrations === undefined ? {} : { migrations: this.migrations });
      return await this.readiness();
    } catch (error) { safe(error, 'initialization'); }
  }

  async readiness() {
    try {
      await this.pool.query('select 1');
      const state = await this.pool.query(
        'select revision from workspace_state where singleton = true'
      );
      if (state.rows.length !== 1) throw new PersistenceError('Workspace state is unavailable');
      await this.mediaStore.readiness();
      return { ready: true, revision: revision(state.rows[0].revision) };
    } catch (error) { safe(error, 'readiness check'); }
  }

  async load() {
    let client;
    let transaction = false;
    try {
      client = await this.pool.connect();
      await client.query('begin isolation level repeatable read read only');
      transaction = true;
      const result = await loaded(client);
      await client.query('commit');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { await client.query('rollback'); } catch {}
      }
      safe(error, 'load');
    } finally { client?.release(); }
  }

  async commit(expectedRevision, workspace, additions = []) {
    let client;
    let transaction = false;
    try {
      const value = importWorkspace(workspace);
      const expected = revision(expectedRevision);
      const referenced = referencedBlobIds(value);
      const workspaceBytes = Buffer.byteLength(JSON.stringify(value));
      const additionIds = new Set((Array.isArray(additions) ? additions : []).map(item => item?.id));
      const retainedIds = [...referenced].filter(id => !additionIds.has(id));
      const retained = retainedIds.length
        ? (await this.pool.query(RETAINED_MEDIA, [retainedIds])).rows : [];
      const retainedById = new Map(retained.map(item => [item.id, item]));
      const missing = retainedIds.find(id => !retainedById.has(id));
      if (missing) {
        throw new MediaPersistenceError('MISSING_MEDIA', 'Referenced media is missing', { id: missing });
      }
      const retainedBytes = retained.reduce((sum, item) => sum + Number(item.size_bytes), 0);
      const verified = await this.mediaStore.putAdditions(additions, referenced, {
        workspaceBytes, retainedBytes
      });

      client = await this.pool.connect();
      await client.query('begin isolation level read committed');
      transaction = true;
      const current = await client.query(
        'select revision from workspace_state where singleton = true for update'
      );
      if (current.rows.length !== 1) throw new PersistenceError('Workspace state is unavailable');
      const actual = revision(current.rows[0].revision);
      if (actual !== expected) throw new RevisionConflictError(expected, actual);

      for (const table of DELETE_ORDER) await client.query(`delete from ${tableName(table)}`);
      const rows = workspaceToRows(value);
      for (const table of INSERT_ORDER) {
        const specification = INSERT_SPECIFICATIONS[table];
        for (const row of rows[table]) {
          await client.query(specification.text, specification.values(row));
        }
      }
      for (const item of verified) {
        await client.query(`insert into media_objects
          (id, object_key, sha256, size_bytes, media_type, original_name, created_at)
          values ($1, $2, $3, $4, $5, $6, now())
          on conflict (id) do update set object_key = excluded.object_key,
            sha256 = excluded.sha256, size_bytes = excluded.size_bytes,
            media_type = excluded.media_type, original_name = excluded.original_name`, [
          item.id, item.objectKey, item.sha256, item.sizeBytes,
          item.mediaType || null, item.originalName || null
        ]);
      }
      const ids = [...referenced];
      const present = ids.length
        ? (await client.query('select id from media_objects where id = any($1::text[])', [ids])).rows
        : [];
      const presentIds = new Set(present.map(item => item.id));
      const absent = ids.find(id => !presentIds.has(id));
      if (absent) throw new MediaPersistenceError('MISSING_MEDIA', 'Referenced media is missing', { id: absent });
      await client.query(
        "delete from media_objects where not exists (select 1 from assets where locator = 'blob:' || media_objects.id)"
      );
      const next = actual + 1;
      await client.query(
        'update workspace_state set revision = $1 where singleton = true', [next]
      );
      const reconstructed = await loaded(client);
      if (reconstructed.revision !== next) throw new PersistenceError('Workspace revision update failed');
      await client.query('commit');
      transaction = false;
      return reconstructed;
    } catch (error) {
      if (transaction) {
        try { await client.query('rollback'); } catch {}
      }
      safe(error, 'commit');
    } finally { client?.release(); }
  }

  async mediaInfo(id) {
    try {
      const result = await this.pool.query(REFERENCED_MEDIA, [id]);
      if (result.rows.length !== 1) throw new PersistenceNotFoundError('media', id);
      const row = result.rows[0];
      const contents = await this.mediaStore.get({
        id: row.id, size: Number(row.size_bytes), sha256: row.sha256
      });
      return {
        contents,
        mediaType: row.media_type || 'application/octet-stream',
        name: row.original_name || ''
      };
    } catch (error) { safe(error, 'media read'); }
  }

  async exportBackup() {
    let client;
    let transaction = false;
    try {
      client = await this.pool.connect();
      let workspace;
      let metadata;
      try {
        await client.query('begin isolation level repeatable read read only');
        transaction = true;
        ({ workspace } = await loaded(client));
        const ids = [...referencedBlobIds(workspace)].sort();
        const rows = (await client.query(
          `select id, sha256, size_bytes, media_type, original_name
            from media_objects where id = any($1::text[])`, [ids]
        )).rows;
        const byId = new Map();
        for (const row of rows) {
          const size = Number(row.size_bytes);
          if (!ids.includes(row.id) || byId.has(row.id)
            || !Number.isSafeInteger(size) || size < 0
            || !VALID_SHA256.test(row.sha256)
            || (row.media_type !== null && typeof row.media_type !== 'string')
            || (row.original_name !== null && typeof row.original_name !== 'string')) {
            throw new MediaPersistenceError(
              'INVALID_MEDIA', 'Referenced media metadata is invalid', { id: row.id }
            );
          }
          byId.set(row.id, {
            id: row.id, size, sha256: row.sha256,
            type: row.media_type ?? '', name: row.original_name ?? ''
          });
        }
        const missing = ids.find(id => !byId.has(id));
        if (missing) {
          throw new MediaPersistenceError(
            'MISSING_MEDIA', 'Referenced media is missing', { id: missing }
          );
        }
        metadata = ids.map(id => byId.get(id));
        await client.query('commit');
        transaction = false;
      } catch (error) {
        if (transaction) {
          try { await client.query('rollback'); } catch {}
        }
        throw error;
      } finally {
        client.release();
        client = undefined;
      }

      const binaries = [];
      for (const item of metadata) {
        const contents = await this.mediaStore.get({
          id: item.id, size: item.size, sha256: item.sha256
        });
        binaries.push({
          id: item.id, type: item.type, name: item.name,
          data: contents.toString('base64')
        });
      }
      return encodeBackup(workspace, binaries);
    } catch (error) { safe(error, 'backup export'); }
    finally { client?.release(); }
  }

  async importBackup(expectedRevision, text) {
    try {
      const backup = decodeBackup(text);
      return await this.commit(expectedRevision, backup.workspace,
        backup.binaries.map(item => ({
          id: item.id, type: item.type, name: item.name, data: item.data
        })));
    } catch (error) { safe(error, 'backup import'); }
  }

  async cleanupMedia(options = {}) {
    try {
      const rows = (await this.pool.query('select id from media_objects')).rows;
      return await this.mediaStore.cleanupMedia({
        ...options, referencedIds: new Set(rows.map(item => item.id))
      });
    } catch (error) { safe(error, 'media cleanup'); }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.pool.end(); }
    catch (error) { safe(error, 'close'); }
  }
}
