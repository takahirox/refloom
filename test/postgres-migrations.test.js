import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MIGRATION_ADVISORY_LOCK,
  readMigrations,
  runPostgresMigrations
} from '../src/postgres-migrations.js';

function entry(name, file = true) {
  return { name, isFile: () => file };
}

test('reads migration bytes in bytewise name order and hashes exact bytes', async () => {
  const files = new Map([
    ['0002_second.sql', Buffer.from('second')],
    ['0001_first.sql', Buffer.from('first')]
  ]);
  const migrations = await readMigrations('/migrations', {
    readdir: async () => [entry('notes.txt'), entry('folder', false), ...[...files.keys()].map((name) => entry(name))],
    readFile: async (url) => files.get(decodeURIComponent(url.pathname.split('/').at(-1)))
  });
  assert.deepEqual(migrations.map(({ version, name }) => [version, name]), [
    ['0001', '0001_first.sql'], ['0002', '0002_second.sql']
  ]);
  assert.equal(migrations[0].sha256, 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e');
  assert.deepEqual(migrations[0].sql, Buffer.from('first'));
});

test('rejects duplicate migration versions', async () => {
  await assert.rejects(readMigrations('/migrations', {
    readdir: async () => [entry('0001_a.sql'), entry('0001_b.sql')],
    readFile: async () => Buffer.from('sql')
  }), (error) => {
    assert.equal(error.code, 'MIGRATION_ERROR');
    assert.deepEqual(error.details, { version: '0001' });
    return true;
  });
});

class FakeClient {
  constructor(applied = []) {
    this.rows = new Map(applied.map((row) => [row.version, row.sha256]));
    this.calls = [];
    this.pending = null;
    this.failSql = false;
    this.released = false;
  }

  async query(text, values) {
    this.calls.push([text, values]);
    if (text.startsWith('select version')) {
      return { rows: [...this.rows].map(([version, sha256]) => ({ version, sha256 })) };
    }
    if (text === 'begin') this.pending = [];
    if (text === 'BAD SQL' && this.failSql) throw new Error('syntax error');
    if (text.startsWith('insert into schema_migrations')) this.pending.push(values.slice(0, 2));
    if (text === 'commit') {
      for (const [version, sha256] of this.pending) this.rows.set(version, sha256);
      this.pending = null;
    }
    if (text === 'rollback') this.pending = null;
    return { rows: [] };
  }

  release() { this.released = true; }
}

const migration = (version, sql, sha256 = `sha-${version}`) => ({
  version, name: `${version}_migration.sql`, sql: Buffer.from(sql), sha256
});

test('locks, creates metadata, applies one transaction per migration, unlocks, and releases', async () => {
  const client = new FakeClient();
  const result = await runPostgresMigrations({ connect: async () => client }, {
    migrations: [migration('0001', 'SQL ONE'), migration('0002', 'SQL TWO')]
  });
  assert.deepEqual(result, { applied: ['0001', '0002'] });
  assert.deepEqual([...client.rows], [['0001', 'sha-0001'], ['0002', 'sha-0002']]);
  assert.equal(client.calls[0][0], 'select pg_advisory_lock($1)');
  assert.deepEqual(client.calls[0][1], [MIGRATION_ADVISORY_LOCK]);
  assert.match(client.calls[1][0], /create table if not exists schema_migrations/);
  assert.equal(client.calls.filter(([sql]) => sql === 'begin').length, 2);
  assert.equal(client.calls.filter(([sql]) => sql === 'commit').length, 2);
  assert.deepEqual(client.calls.at(-1), ['select pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]]);
  assert.equal(client.released, true);
});

test('a second run is a no-op for matching applied checksums', async () => {
  const client = new FakeClient([{ version: '0001', sha256: 'same' }]);
  const result = await runPostgresMigrations({ connect: async () => client }, {
    migrations: [migration('0001', 'SQL', 'same')]
  });
  assert.deepEqual(result, { applied: [] });
  assert.equal(client.calls.some(([sql]) => sql === 'begin'), false);
  assert.equal(client.released, true);
});

test('checksum mismatch fails closed, unlocks, and releases', async () => {
  const client = new FakeClient([{ version: '0001', sha256: 'old' }]);
  await assert.rejects(runPostgresMigrations({ connect: async () => client }, {
    migrations: [migration('0001', 'changed', 'new')]
  }), (error) => {
    assert.equal(error.code, 'MIGRATION_CHECKSUM_MISMATCH');
    assert.deepEqual(error.details, { version: '0001', expectedSha256: 'old', actualSha256: 'new' });
    return true;
  });
  assert.deepEqual([...client.rows], [['0001', 'old']]);
  assert.equal(client.calls.at(-1)[0], 'select pg_advisory_unlock($1)');
  assert.equal(client.released, true);
});

test('failed SQL rolls back without recording the migration and still cleans up', async () => {
  const client = new FakeClient();
  client.failSql = true;
  await assert.rejects(runPostgresMigrations({ connect: async () => client }, {
    migrations: [migration('0001', 'BAD SQL')]
  }), (error) => {
    assert.equal(error.code, 'MIGRATION_ERROR');
    assert.equal(error.details.version, '0001');
    assert.equal(error.cause.message, 'syntax error');
    return true;
  });
  assert.equal(client.calls.some(([sql]) => sql === 'rollback'), true);
  assert.deepEqual([...client.rows], []);
  assert.equal(client.calls.at(-1)[0], 'select pg_advisory_unlock($1)');
  assert.equal(client.released, true);
});

test('the committed migration defines all normalized tables and required constraints', async () => {
  const sql = await readFile(new URL('../migrations/0001_persistence.sql', import.meta.url), 'utf8');
  for (const table of [
    'workspace_state', 'projects', 'references', 'reference_tags', 'assets', 'targets', 'moments',
    'selections', 'boards', 'board_selections', 'signals', 'media_objects'
  ]) assert.match(sql, new RegExp(`create table ${table === 'references' ? '"references"' : table} \\(`));
  assert.match(sql, /reference_id text not null references "references"\(id\) on delete cascade/);
  assert.match(sql, /primary key \(reference_id, position\)/);
  assert.match(sql, /unique \(reference_id, tag\)/);
  assert.match(sql, /foreign key \(reference_id, project_id\) references "references"\(id, project_id\)/);
  assert.match(sql, /foreign key \(asset_id, reference_id\) references assets\(id, reference_id\)/);
  assert.match(sql, /foreign key \(moment_id, target_id\) references moments\(id, target_id\)/);
  assert.match(sql, /unique \(board_id, position\)/);
  assert.match(sql, /sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('capture settings migration adds a non-null JSON object with default-on behavior', async () => {
  const sql = await readFile(new URL('../migrations/0002_workspace_capture_settings.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column settings jsonb not null/);
  assert.match(sql, /"automaticWebsiteCapture": true/);
  assert.match(sql, /jsonb_typeof\(settings\) = 'object'/);
});
