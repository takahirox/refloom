import { createHash } from 'node:crypto';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { MediaPersistenceError } from './persistence-errors.js';

export const MEDIA_PREFIX = 'media/';
export const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const DEFAULT_MEDIA_LIMITS = Object.freeze({
  mediaBytes: 25 * 1024 * 1024,
  workspaceBytes: 5 * 1024 * 1024,
  totalBytes: 250 * 1024 * 1024
});
export const DEFAULT_CLEANUP_LIMIT = 1000;
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const keyFor = id => `${MEDIA_PREFIX}${id}`;

function fail(code, message, details, cause) {
  throw new MediaPersistenceError(code, message, details, { cause });
}

function validId(id) {
  if (typeof id !== 'string' || !MEDIA_ID.test(id)) {
    fail('INVALID_MEDIA_ID', 'Media identifier must be an opaque URL-safe identifier');
  }
  return id;
}

function bytesFor(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value !== 'string' || !BASE64.test(value)) {
    fail('INVALID_MEDIA', 'Media data must be a Buffer or canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    fail('INVALID_MEDIA', 'Media data must be canonical base64');
  }
  return bytes;
}

function expectedHead(head, expected) {
  return Number(head?.ContentLength) === expected.size
    && head?.Metadata?.sha256 === expected.sha256;
}

function absent(error) {
  return error?.name === 'NotFound' || error?.name === 'NoSuchKey'
    || error?.$metadata?.httpStatusCode === 404;
}

function conditional(error) {
  return error?.name === 'PreconditionFailed'
    || error?.$metadata?.httpStatusCode === 412;
}

function safeFailure(operation, error, details = {}) {
  return new MediaPersistenceError('MEDIA_SERVICE_ERROR', `S3 ${operation} failed`, details, { cause: error });
}

export class S3MediaStore {
  constructor({ client, bucket, limits, cleanupLimit = DEFAULT_CLEANUP_LIMIT,
    orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS, now = () => Date.now() } = {}) {
    if (!client || typeof client.send !== 'function') throw new TypeError('S3 client must provide send()');
    if (typeof bucket !== 'string' || !bucket) throw new TypeError('S3 bucket is required');
    this.client = client;
    this.bucket = bucket;
    this.limits = { ...DEFAULT_MEDIA_LIMITS, ...limits };
    this.cleanupLimit = cleanupLimit;
    this.orphanGraceMs = orphanGraceMs;
    this.now = now;
  }

  async readiness() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      throw safeFailure('readiness check', error);
    }
  }

  validateAdditions(additions, referencedIds, { workspaceBytes = 0, retainedBytes = 0 } = {}) {
    if (!Array.isArray(additions)) fail('INVALID_MEDIA', 'Media additions must be an array');
    const references = referencedIds instanceof Set ? referencedIds : new Set(referencedIds ?? []);
    if (!Number.isSafeInteger(workspaceBytes) || workspaceBytes < 0
      || workspaceBytes > this.limits.workspaceBytes) {
      fail('WORKSPACE_TOO_LARGE', 'Workspace exceeds the configured size limit');
    }
    const seen = new Set();
    let addedBytes = 0;
    const prepared = additions.map(item => {
      const id = validId(item?.id);
      if (seen.has(id)) fail('DUPLICATE_MEDIA', `Media ${id} is included more than once`, { id });
      seen.add(id);
      if (!references.has(id)) fail('ORPHAN_MEDIA', `Media ${id} is not referenced`, { id });
      const contents = bytesFor(item?.data);
      if (contents.length > this.limits.mediaBytes) {
        fail('MEDIA_TOO_LARGE', `Media ${id} exceeds the configured size limit`, { id });
      }
      addedBytes += contents.length;
      return {
        id,
        key: keyFor(id),
        contents,
        size: contents.length,
        sha256: sha256(contents),
        mediaType: typeof item.type === 'string' ? item.type : '',
        name: typeof item.name === 'string' ? item.name : ''
      };
    });
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0
      || retainedBytes + addedBytes > this.limits.totalBytes) {
      fail('MEDIA_LIMIT', 'Workspace media exceeds the configured total size limit');
    }
    return prepared;
  }

  async putAdditions(additions, referencedIds, sizes) {
    const prepared = this.validateAdditions(additions, referencedIds, sizes);
    const result = [];
    for (const item of prepared) result.push(await this.put(item));
    return result;
  }

  async #head(item) {
    return this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: item.key }));
  }

  #verified(item, head) {
    if (!expectedHead(head, item)) {
      fail('MEDIA_COLLISION', `Stored media ${item.id} does not match`, { id: item.id });
    }
    return {
      id: item.id,
      objectKey: item.key,
      sha256: item.sha256,
      sizeBytes: item.size,
      mediaType: item.mediaType,
      originalName: item.name
    };
  }

  async put(item) {
    validId(item?.id);
    try {
      const head = await this.#head(item);
      return this.#verified(item, head);
    } catch (error) {
      if (error instanceof MediaPersistenceError) throw error;
      if (!absent(error)) throw safeFailure('head', error, { id: item.id });
    }

    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: item.key,
        Body: item.contents,
        ContentLength: item.size,
        ...(item.mediaType ? { ContentType: item.mediaType } : {}),
        Metadata: { sha256: item.sha256 },
        IfNoneMatch: '*'
      }));
    } catch (error) {
      if (!conditional(error)) throw safeFailure('put', error, { id: item.id });
    }

    let head;
    try {
      head = await this.#head(item);
    } catch (error) {
      throw safeFailure('verification', error, { id: item.id });
    }
    return this.#verified(item, head);
  }

  async get({ id, size, sha256: digest }) {
    validId(id);
    if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.mediaBytes
      || !/^[0-9a-f]{64}$/.test(digest ?? '')) {
      fail('INVALID_MEDIA_METADATA', 'Stored media metadata is invalid', { id });
    }
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: keyFor(id) }));
    } catch (error) {
      throw safeFailure('get', error, { id });
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of response.Body) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > size || length > this.limits.mediaBytes) {
          fail('MEDIA_VERIFICATION_FAILED', `Stored media ${id} exceeds its expected size`, { id });
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (error instanceof MediaPersistenceError) throw error;
      throw safeFailure('body read', error, { id });
    }
    const contents = Buffer.concat(chunks, length);
    if (length !== size || sha256(contents) !== digest) {
      fail('MEDIA_VERIFICATION_FAILED', `Stored media ${id} failed integrity verification`, { id });
    }
    return contents;
  }

  async cleanupMedia({ referencedIds = new Set(), graceMs = this.orphanGraceMs,
    limit = this.cleanupLimit } = {}) {
    const referenced = referencedIds instanceof Set ? referencedIds : new Set(referencedIds);
    const bound = Math.max(0, Math.min(Number.isSafeInteger(limit) ? limit : this.cleanupLimit, this.cleanupLimit));
    const cutoff = this.now() - graceMs;
    const failures = [];
    const candidates = [];
    let examined = 0;
    let token;
    try {
      while (examined < bound) {
        const page = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: MEDIA_PREFIX,
          MaxKeys: Math.min(1000, bound - examined),
          ...(token ? { ContinuationToken: token } : {})
        }));
        for (const object of page.Contents ?? []) {
          if (examined++ >= bound) break;
          const key = object.Key;
          const id = typeof key === 'string' && key.startsWith(MEDIA_PREFIX)
            ? key.slice(MEDIA_PREFIX.length) : '';
          if (MEDIA_ID.test(id) && !referenced.has(id)
            && object.LastModified instanceof Date && object.LastModified.getTime() < cutoff) {
            candidates.push({ Key: key });
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (!token || !(page.Contents?.length)) break;
      }
      for (let offset = 0; offset < candidates.length; offset += 1000) {
        const Objects = candidates.slice(offset, offset + 1000);
        try {
          const response = await this.client.send(new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects, Quiet: true }
          }));
          for (const error of response.Errors ?? []) {
            failures.push({ key: error.Key, code: error.Code ?? 'DELETE_FAILED' });
          }
        } catch (error) {
          failures.push({ code: 'MEDIA_SERVICE_ERROR', operation: 'delete' });
        }
      }
    } catch (error) {
      failures.push({ code: 'MEDIA_SERVICE_ERROR', operation: 'list' });
    }
    return { examined, deleted: candidates.length - failures.filter(item => item.operation === 'delete' || item.key).length, failures };
  }
}
