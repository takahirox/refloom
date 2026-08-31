import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { MediaPersistenceError } from '../src/persistence-errors.js';
import {
  DEFAULT_MEDIA_LIMITS,
  S3MediaStore
} from '../src/s3-media-store.js';
import {
  PersistenceRepository,
  validatePersistenceRepository
} from '../src/persistence-repository.js';

const notFound = () => Object.assign(new Error('missing'), {
  name: 'NotFound', $metadata: { httpStatusCode: 404 }
});
const precondition = () => Object.assign(new Error('race'), {
  name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 }
});
const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

class FakeClient {
  constructor(responses = []) { this.responses = [...responses]; this.commands = []; }
  async send(command) {
    this.commands.push(command);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === 'function') return response(command);
    return response ?? {};
  }
}

const store = (client, options = {}) => new S3MediaStore({
  client, bucket: 'private-bucket', ...options
});

test('repository contract validates behavior without providing storage', () => {
  assert.throws(() => new PersistenceRepository().load(), /must be implemented/);
  const repository = Object.fromEntries([
    'initialize', 'readiness', 'load', 'commit', 'mediaInfo', 'exportBackup',
    'importBackup', 'cleanupMedia', 'close'
  ].map(name => [name, () => {}]));
  assert.equal(validatePersistenceRepository(repository), repository);
  assert.throws(() => validatePersistenceRepository({}), /initialize/);
});

test('exports the documented media, workspace, and total defaults', () => {
  assert.deepEqual(DEFAULT_MEDIA_LIMITS, {
    mediaBytes: 25 * 1024 * 1024,
    workspaceBytes: 5 * 1024 * 1024,
    totalBytes: 250 * 1024 * 1024
  });
});

test('validates IDs, duplicates, orphans, canonical data, and limits before network', async () => {
  for (const additions of [
    [{ id: '../bad', data: '' }],
    [{ id: 'same', data: '' }, { id: 'same', data: '' }],
    [{ id: 'orphan', data: '' }],
    [{ id: 'one', data: 'YQ' }]
  ]) {
    const client = new FakeClient();
    const s3 = store(client);
    await assert.rejects(s3.putAdditions(additions, new Set(['one', 'same'])), MediaPersistenceError);
    assert.equal(client.commands.length, 0);
  }
  const client = new FakeClient();
  const limited = store(client, { limits: { mediaBytes: 1, workspaceBytes: 1, totalBytes: 1 } });
  await assert.rejects(limited.putAdditions([{ id: 'one', data: Buffer.from('ab') }], new Set(['one'])));
  await assert.rejects(limited.putAdditions([], new Set(), { workspaceBytes: 2 }));
  await assert.rejects(limited.putAdditions([{ id: 'one', data: 'YQ==' }], new Set(['one']), { retainedBytes: 1 }));
  assert.equal(client.commands.length, 0);
});

test('uploads conditionally then verifies before returning metadata', async () => {
  const client = new FakeClient([
    notFound(),
    {},
    { ContentLength: 5, Metadata: { sha256: digest } }
  ]);
  const result = await store(client).putAdditions([
    { id: 'asset_1', data: Buffer.from('hello'), type: 'text/plain', name: 'hello.txt' }
  ], new Set(['asset_1']));
  assert.deepEqual(client.commands.map(item => item.constructor), [
    HeadObjectCommand, PutObjectCommand, HeadObjectCommand
  ]);
  assert.deepEqual(client.commands[0].input, {
    Bucket: 'private-bucket', Key: 'media/asset_1'
  });
  assert.deepEqual(client.commands[1].input, {
    Bucket: 'private-bucket', Key: 'media/asset_1', Body: Buffer.from('hello'),
    ContentLength: 5, ContentType: 'text/plain', Metadata: { sha256: digest }, IfNoneMatch: '*'
  });
  assert.deepEqual(result[0], {
    id: 'asset_1', objectKey: 'media/asset_1', sha256: digest, sizeBytes: 5,
    mediaType: 'text/plain', originalName: 'hello.txt'
  });
});

test('accepts an exactly matching existing object without putting', async () => {
  const client = new FakeClient([{ ContentLength: 5, Metadata: { sha256: digest } }]);
  await store(client).putAdditions([{ id: 'one', data: 'aGVsbG8=' }], new Set(['one']));
  assert.deepEqual(client.commands.map(item => item.constructor), [HeadObjectCommand]);
});

test('rejects existing collisions and post-put verification mismatches', async () => {
  const existing = new FakeClient([{ ContentLength: 4, Metadata: { sha256: digest } }]);
  await assert.rejects(
    store(existing).putAdditions([{ id: 'one', data: 'aGVsbG8=' }], new Set(['one'])),
    error => error.code === 'MEDIA_COLLISION'
  );
  const uploaded = new FakeClient([notFound(), {}, { ContentLength: 5, Metadata: { sha256: '0'.repeat(64) } }]);
  await assert.rejects(
    store(uploaded).putAdditions([{ id: 'one', data: 'aGVsbG8=' }], new Set(['one'])),
    error => error.code === 'MEDIA_COLLISION'
  );
});

test('re-heads and verifies after a conditional race', async () => {
  const matching = new FakeClient([
    notFound(), precondition(), { ContentLength: 5, Metadata: { sha256: digest } }
  ]);
  await store(matching).putAdditions([{ id: 'one', data: 'aGVsbG8=' }], new Set(['one']));
  assert.deepEqual(matching.commands.map(item => item.constructor), [
    HeadObjectCommand, PutObjectCommand, HeadObjectCommand
  ]);
  const collision = new FakeClient([
    notFound(), precondition(), { ContentLength: 6, Metadata: { sha256: digest } }
  ]);
  await assert.rejects(
    store(collision).putAdditions([{ id: 'one', data: 'aGVsbG8=' }], new Set(['one'])),
    error => error.code === 'MEDIA_COLLISION'
  );
});

test('reads through a bounded stream and verifies size and digest', async () => {
  const client = new FakeClient([{ Body: Readable.from([Buffer.from('he'), Buffer.from('llo')]) }]);
  assert.deepEqual(await store(client).get({ id: 'one', size: 5, sha256: digest }), Buffer.from('hello'));
  assert.ok(client.commands[0] instanceof GetObjectCommand);
  assert.deepEqual(client.commands[0].input, { Bucket: 'private-bucket', Key: 'media/one' });

  const oversized = new FakeClient([{ Body: Readable.from([Buffer.from('hello!')]) }]);
  await assert.rejects(store(oversized).get({ id: 'one', size: 5, sha256: digest }),
    error => error.code === 'MEDIA_VERIFICATION_FAILED');
  const changed = new FakeClient([{ Body: Readable.from([Buffer.from('jello')]) }]);
  await assert.rejects(store(changed).get({ id: 'one', size: 5, sha256: digest }),
    error => error.code === 'MEDIA_VERIFICATION_FAILED');
});

test('checks bucket readiness and returns a typed secret-free failure', async () => {
  const ready = new FakeClient([{}]);
  assert.equal(await store(ready).readiness(), true);
  assert.ok(ready.commands[0] instanceof HeadBucketCommand);
  assert.deepEqual(ready.commands[0].input, { Bucket: 'private-bucket' });

  const unavailable = new FakeClient([new Error('endpoint with secret')]);
  await assert.rejects(store(unavailable).readiness(), error => {
    assert.equal(error.code, 'MEDIA_SERVICE_ERROR');
    assert.equal(error.message, 'S3 readiness check failed');
    assert.equal(JSON.stringify(error.details ?? {}), '{}');
    return true;
  });
});

test('cleanup is prefix, grace, limit, and reference safe', async () => {
  const now = Date.parse('2026-09-01T12:00:00Z');
  const old = new Date(now - 25 * 60 * 60 * 1000);
  const recent = new Date(now - 60 * 60 * 1000);
  const client = new FakeClient([{
    Contents: [
      { Key: 'media/referenced', LastModified: old },
      { Key: 'media/orphan', LastModified: old },
      { Key: 'media/recent', LastModified: recent }
    ], IsTruncated: false
  }, {}]);
  const result = await store(client, { now: () => now }).cleanupMedia({
    referencedIds: new Set(['referenced']), limit: 3
  });
  assert.equal(result.examined, 3);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.failures, []);
  assert.ok(client.commands[0] instanceof ListObjectsV2Command);
  assert.deepEqual(client.commands[0].input, {
    Bucket: 'private-bucket', Prefix: 'media/', MaxKeys: 3
  });
  assert.ok(client.commands[1] instanceof DeleteObjectsCommand);
  assert.deepEqual(client.commands[1].input.Delete, {
    Objects: [{ Key: 'media/orphan' }], Quiet: true
  });
});

test('cleanup caps examination and records list or delete failures without throwing', async () => {
  const now = Date.now();
  const deleting = new FakeClient([{
    Contents: [{ Key: 'media/a', LastModified: new Date(0) }], IsTruncated: false
  }, new Error('unavailable')]);
  const deleted = await store(deleting, { now: () => now }).cleanupMedia({ limit: 1 });
  assert.deepEqual(deleted.failures, [{ code: 'MEDIA_SERVICE_ERROR', operation: 'delete' }]);

  const listing = new FakeClient([new Error('unavailable')]);
  const listed = await store(listing).cleanupMedia();
  assert.deepEqual(listed, {
    examined: 0, deleted: 0,
    failures: [{ code: 'MEDIA_SERVICE_ERROR', operation: 'list' }]
  });
});
