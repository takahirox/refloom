import assert from 'node:assert/strict';
import test from 'node:test';
import { createAsset, createProject, createReference, createWorkspace } from '../src/domain.js';
import { PersistenceError, RevisionConflictError } from '../src/persistence-errors.js';
import { PostgresWorkspaceRepository } from '../src/postgres-workspace-repository.js';
import { workspaceToRows } from '../src/postgres-workspace-mapper.js';
import { encodeBackup } from '../src/storage.js';

const emptyRows = () => ({
  projects: [], references: [], assets: [], targets: [], moments: [], selections: [],
  boards: [], board_selections: [], signals: []
});

function workspaceWithBlob(id = 'blob_1') {
  let value = createProject(createWorkspace(), { id: 'p', title: 'Project' });
  value = createReference(value, { id: 'r', projectId: 'p', captureMethod: 'manual' });
  return createAsset(value, {
    id: 'a', referenceId: 'r', kind: 'image', locator: `blob:${id}`,
    mediaType: 'text/plain'
  });
}

class FakeMediaStore {
  constructor() {
    this.limits = { workspaceBytes: 100000, mediaBytes: 100000, totalBytes: 100000 };
    this.calls = [];
    this.contents = Buffer.from('hello');
  }
  async readiness() { this.calls.push('ready'); return true; }
  async putAdditions(additions, referenced, sizes) {
    this.calls.push(['put', additions, [...referenced], sizes]);
    return additions.map(item => ({
      id: item.id, objectKey: `media/${item.id}`, sha256: 'a'.repeat(64),
      sizeBytes: Buffer.from(item.data, 'base64').length, mediaType: item.type,
      originalName: item.name
    }));
  }
  async get(metadata) { this.calls.push(['get', metadata]); return this.contents; }
  async cleanupMedia(options) { this.calls.push(['cleanup', options]); return { deleted: 0 }; }
}

class FakePool {
  constructor(handler) {
    this.handler = handler;
    this.queries = [];
    this.client = {
      query: (text, values) => this.query(text, values, true),
      release: () => { this.released = true; }
    };
    this.ends = 0;
  }
  async query(text, values, client = false) {
    this.queries.push({ text: String(text), values, client });
    return this.handler(String(text), values, client, this.queries) ?? { rows: [] };
  }
  async connect() { this.connected = true; return this.client; }
  async end() { this.ends += 1; }
}

const selectRows = (sets, revision = 0) => text => {
  if (text.startsWith('select revision')) return { rows: [{ revision }] };
  for (const [table, rows] of Object.entries(sets)) {
    if (text.startsWith(`select * from ${table}`)) return { rows };
  }
  if (text === 'select 1') return { rows: [{ '?column?': 1 }] };
  return { rows: [] };
};

test('initialize runs injected migrations and readiness checks database, singleton, and media', async () => {
  const pool = new FakePool(text => {
    if (text.startsWith('select pg_advisory')) return { rows: [] };
    if (text.startsWith('select version')) return { rows: [] };
    if (text.startsWith('select revision')) return { rows: [{ revision: '4' }] };
    return { rows: [] };
  });
  const mediaStore = new FakeMediaStore();
  const repository = new PostgresWorkspaceRepository({ pool, mediaStore, migrations: [] });
  assert.deepEqual(await repository.initialize(), { ready: true, revision: 4 });
  assert.ok(pool.queries.some(item => item.text === 'select 1'));
  assert.deepEqual(mediaStore.calls, ['ready']);
});

test('load reconstructs all fixed row sets and preserves board position query', async () => {
  const sets = emptyRows();
  const pool = new FakePool(selectRows(sets, '2'));
  const result = await new PostgresWorkspaceRepository({
    pool, mediaStore: new FakeMediaStore()
  }).load();
  assert.equal(result.revision, 2);
  assert.deepEqual(result.workspace, createWorkspace());
  const selects = pool.queries.filter(item => item.text.startsWith('select *'));
  assert.equal(selects.length, 9);
  assert.ok(selects.every(item => item.values === undefined));
  assert.equal(selects[7].text,
    'select * from board_selections order by board_id, position');
  assert.equal(pool.queries[0].text, 'begin isolation level repeatable read read only');
  assert.equal(pool.queries.at(-1).text, 'commit');
  assert.ok(pool.queries.every(item => item.client));
  assert.equal(pool.released, true);
});

test('load rolls back and releases a failed snapshot', async () => {
  const pool = new FakePool(text => {
    if (text.startsWith('select revision')) throw new Error('database secret');
    return { rows: [] };
  });
  await assert.rejects(new PostgresWorkspaceRepository({
    pool, mediaStore: new FakeMediaStore()
  }).load(), error => {
    assert.equal(error.message, 'PostgreSQL workspace load failed');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(pool.queries.at(-1).text, 'rollback');
  assert.equal(pool.released, true);
});

function commitPool({ actual = 0, failDelete = false, retained = [] } = {}) {
  const sets = emptyRows();
  return new FakePool((text, values, client) => {
    if (text.includes('from media_objects where id = any')) return { rows: retained };
    if (text === 'select id from media_objects where id = any($1::text[])') {
      return { rows: (values[0] ?? []).map(id => ({ id })) };
    }
    if (text === 'select revision from workspace_state where singleton = true for update') {
      return { rows: [{ revision: actual }] };
    }
    if (failDelete && client && text === 'delete from signals') throw new Error('database URL secret');
    if (text.startsWith('select revision')) return { rows: [{ revision: actual + 1 }] };
    for (const [table, rows] of Object.entries(sets)) {
      if (text.startsWith(`select * from ${table}`)) return { rows };
    }
    return { rows: [] };
  });
}

test('commit verifies upload before BEGIN, locks before replacement, and commits revision +1', async () => {
  const pool = commitPool();
  const mediaStore = new FakeMediaStore();
  const repository = new PostgresWorkspaceRepository({ pool, mediaStore });
  const result = await repository.commit(0, createWorkspace(), []);
  assert.equal(result.revision, 1);
  const texts = pool.queries.map(item => item.text);
  const begin = texts.indexOf('begin isolation level read committed');
  const lock = texts.indexOf('select revision from workspace_state where singleton = true for update');
  const firstDelete = texts.indexOf('delete from signals');
  assert.ok(begin >= 0 && begin < lock && lock < firstDelete);
  assert.ok(texts.indexOf('commit') > texts.findIndex(text => text.startsWith('update workspace_state')));
  assert.equal(mediaStore.calls[0][0], 'put');
});

test('stale conflict rolls back before replacing rows', async () => {
  const pool = commitPool({ actual: 5 });
  const repository = new PostgresWorkspaceRepository({
    pool, mediaStore: new FakeMediaStore()
  });
  await assert.rejects(repository.commit(4, createWorkspace(), []), RevisionConflictError);
  const texts = pool.queries.map(item => item.text);
  assert.ok(texts.includes('rollback'));
  assert.equal(texts.some(text => text.startsWith('delete from ')), false);
});

test('database failure after verified upload rolls back and leaves the durable orphan', async () => {
  const pool = commitPool({ failDelete: true });
  const mediaStore = new FakeMediaStore();
  const repository = new PostgresWorkspaceRepository({ pool, mediaStore });
  await assert.rejects(repository.commit(0, workspaceWithBlob(), [{
    id: 'blob_1', data: 'aGVsbG8=', type: 'text/plain', name: 'hello.txt'
  }]), error => {
    assert.ok(error instanceof PersistenceError);
    assert.equal(error.message, 'PostgreSQL workspace commit failed');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  assert.equal(mediaStore.calls.filter(item => Array.isArray(item) && item[0] === 'put').length, 1);
  assert.ok(pool.queries.some(item => item.text === 'rollback'));
  assert.equal(mediaStore.calls.some(item => Array.isArray(item) && item[0] === 'cleanup'), false);
});

test('missing retained media is rejected before upload or transaction', async () => {
  const pool = commitPool();
  const mediaStore = new FakeMediaStore();
  await assert.rejects(new PostgresWorkspaceRepository({ pool, mediaStore })
    .commit(0, workspaceWithBlob(), []), error => error.code === 'MISSING_MEDIA');
  assert.equal(mediaStore.calls.length, 0);
  assert.equal(pool.connected, undefined);
  const metadataQuery = pool.queries[0];
  assert.deepEqual(metadataQuery.values, [['blob_1']]);
});

test('hostile media IDs remain parameters and never enter SQL text', async () => {
  const hostile = "x') or true --";
  const pool = new FakePool(() => ({ rows: [] }));
  const repository = new PostgresWorkspaceRepository({
    pool, mediaStore: new FakeMediaStore()
  });
  await assert.rejects(repository.mediaInfo(hostile), error => error.code === 'PERSISTENCE_NOT_FOUND');
  assert.equal(pool.queries[0].text.includes(hostile), false);
  assert.deepEqual(pool.queries[0].values, [hostile]);
});

test('mediaInfo authorizes only an authoritative asset reference before verified S3 read', async () => {
  const mediaStore = new FakeMediaStore();
  const pool = new FakePool((text, values) => {
    assert.ok(text.includes("a.locator = 'blob:' || m.id"));
    assert.deepEqual(values, ['blob_1']);
    return { rows: [{
      id: 'blob_1', sha256: 'a'.repeat(64), size_bytes: '5',
      media_type: 'text/plain', original_name: 'hello.txt'
    }] };
  });
  assert.deepEqual(await new PostgresWorkspaceRepository({ pool, mediaStore })
    .mediaInfo('blob_1'), {
    contents: Buffer.from('hello'), mediaType: 'text/plain', name: 'hello.txt'
  });
  assert.deepEqual(mediaStore.calls[0], ['get', {
    id: 'blob_1', size: 5, sha256: 'a'.repeat(64)
  }]);
});

test('cleanup passes exactly current media_objects IDs', async () => {
  const pool = new FakePool(text => text === 'select id from media_objects'
    ? { rows: [{ id: 'keep-a' }, { id: 'keep-b' }] } : { rows: [] });
  const mediaStore = new FakeMediaStore();
  await new PostgresWorkspaceRepository({ pool, mediaStore }).cleanupMedia({ limit: 7 });
  const options = mediaStore.calls[0][1];
  assert.equal(options.limit, 7);
  assert.deepEqual([...options.referencedIds], ['keep-a', 'keep-b']);
});

test('backup export captures one snapshot then fetches verified objects as backup v2', async () => {
  const workspace = workspaceWithBlob();
  const events = [];
  const pool = new FakePool((text, values, client) => {
    events.push(text);
    if (text.startsWith('select revision')) return { rows: [{ revision: 3 }] };
    if (text.startsWith('select * from projects')) return { rows: [{
      id: 'p', title: 'Project', brief: null,
      created_at: workspace.projects[0].createdAt, updated_at: workspace.projects[0].updatedAt
    }] };
    if (text.startsWith('select * from "references"')) return { rows: [{
      id: 'r', project_id: 'p', title: null, source_url: null, creator: null, notes: null,
      captured_at: workspace.references[0].capturedAt, capture_method: 'manual',
      created_at: workspace.references[0].createdAt, updated_at: workspace.references[0].updatedAt
    }] };
    if (text.startsWith('select * from assets')) return { rows: [{
      id: 'a', project_id: 'p', reference_id: 'r', kind: 'image', locator: 'blob:blob_1',
      media_type: 'text/plain', captured_at: workspace.assets[0].capturedAt, provenance: {},
      created_at: workspace.assets[0].createdAt, updated_at: workspace.assets[0].updatedAt
    }] };
    if (text.startsWith('select *')) return { rows: [] };
    if (text.includes('from media_objects where id = any')) return { rows: [{
      id: 'blob_1', sha256: 'a'.repeat(64), size_bytes: 5,
      media_type: 'text/plain', original_name: 'hello.txt'
    }] };
    return { rows: [] };
  });
  const mediaStore = new FakeMediaStore();
  const originalGet = mediaStore.get.bind(mediaStore);
  mediaStore.get = async metadata => {
    events.push('s3:get');
    return originalGet(metadata);
  };
  const repository = new PostgresWorkspaceRepository({ pool, mediaStore });
  const backup = JSON.parse(await repository.exportBackup());
  assert.equal(backup.version, 2);
  assert.equal(backup.binaries[0].data, 'aGVsbG8=');
  assert.equal(backup.binaries[0].type, 'text/plain');
  assert.equal(backup.binaries[0].name, 'hello.txt');
  assert.equal(backup.binaries[0].size, 5);
  const metadataQuery = pool.queries.find(item =>
    item.text.includes('from media_objects where id = any'));
  assert.deepEqual(metadataQuery.values, [['blob_1']]);
  assert.equal(metadataQuery.text.includes('blob_1'), false);
  assert.ok(pool.queries.every(item => item.client));
  assert.ok(events.indexOf('begin isolation level repeatable read read only')
    < events.indexOf('select revision from workspace_state where singleton = true'));
  assert.ok(events.indexOf('commit') < events.indexOf('s3:get'));
  assert.equal(pool.released, true);
  assert.deepEqual(mediaStore.calls[0], ['get', {
    id: 'blob_1', size: 5, sha256: 'a'.repeat(64)
  }]);
});

test('backup export rolls back missing metadata without fetching S3', async () => {
  const workspace = workspaceWithBlob();
  const rows = workspaceToRows(workspace);
  const pool = new FakePool(text => {
    if (text.startsWith('select revision')) return { rows: [{ revision: 3 }] };
    for (const [table, tableRows] of Object.entries(rows)) {
      const sqlTable = table === 'references' ? '"references"' : table;
      if (text.startsWith(`select * from ${sqlTable}`)) return { rows: tableRows };
    }
    return { rows: [] };
  });
  const mediaStore = new FakeMediaStore();
  await assert.rejects(new PostgresWorkspaceRepository({ pool, mediaStore }).exportBackup(),
    error => error.code === 'MISSING_MEDIA');
  assert.ok(pool.queries.some(item => item.text === 'rollback'));
  assert.equal(pool.queries.some(item => item.text === 'commit'), false);
  assert.equal(pool.released, true);
  assert.equal(mediaStore.calls.length, 0);
});

test('backup export propagates verified S3 failure after committing snapshot', async () => {
  const workspace = workspaceWithBlob();
  const rows = workspaceToRows(workspace);
  const pool = new FakePool(text => {
    if (text.startsWith('select revision')) return { rows: [{ revision: 3 }] };
    for (const [table, tableRows] of Object.entries(rows)) {
      const sqlTable = table === 'references' ? '"references"' : table;
      if (text.startsWith(`select * from ${sqlTable}`)) return { rows: tableRows };
    }
    if (text.includes('from media_objects where id = any')) return { rows: [{
      id: 'blob_1', sha256: 'a'.repeat(64), size_bytes: 5,
      media_type: 'text/plain', original_name: 'hello.txt'
    }] };
    return { rows: [] };
  });
  const mediaStore = new FakeMediaStore();
  mediaStore.get = async () => { throw new Error('object changed'); };
  await assert.rejects(new PostgresWorkspaceRepository({ pool, mediaStore }).exportBackup(),
    /backup export failed/);
  assert.ok(pool.queries.some(item => item.text === 'commit'));
  assert.equal(pool.queries.some(item => item.text === 'rollback'), false);
  assert.equal(pool.released, true);
});

test('backup import fully decodes v2 before invoking commit', async () => {
  const workspace = workspaceWithBlob();
  const repository = new PostgresWorkspaceRepository({
    pool: new FakePool(() => ({ rows: [] })), mediaStore: new FakeMediaStore()
  });

  let committed;
  repository.commit = async (...args) => { committed = args; return { revision: 4, workspace }; };
  await repository.importBackup(3, encodeBackup(workspace, [{
    id: 'blob_1', type: 'text/plain', name: 'hello.txt', data: 'aGVsbG8='
  }]));
  assert.equal(committed[0], 3);
  assert.deepEqual(committed[1], workspace);
  assert.equal(committed[2][0].id, 'blob_1');

  committed = undefined;
  await assert.rejects(repository.importBackup(3, '{'), error =>
    error instanceof PersistenceError && /backup import failed/.test(error.message)
      && /valid JSON/.test(error.cause?.message));
  assert.equal(committed, undefined);
  await assert.rejects(repository.importBackup(3, JSON.stringify({
    format: 'refloom.workspace-backup', version: 1,
    workspace, binaries: []
  })), error => error instanceof PersistenceError
    && /backup import failed/.test(error.message) && /version/.test(error.cause?.message));
  assert.equal(committed, undefined);
});

test('close ends the pool once', async () => {
  const pool = new FakePool(() => ({ rows: [] }));
  const repository = new PostgresWorkspaceRepository({
    pool, mediaStore: new FakeMediaStore()
  });
  await repository.close();
  await repository.close();
  assert.equal(pool.ends, 1);
});
