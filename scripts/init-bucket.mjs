import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { readPersistenceConfig } from '../src/persistence-config.js';

const config = readPersistenceConfig({
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://unused:unused@localhost/unused'
});
const client = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { ...config.s3.credentials },
  followRegionRedirects: false,
  maxAttempts: 3
});

try {
  await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
} catch (error) {
  if (error?.$metadata?.httpStatusCode !== 404 && error?.name !== 'NotFound'
    && error?.name !== 'NoSuchBucket') throw error;
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
  } catch (createError) {
    if (createError?.name !== 'BucketAlreadyOwnedByYou'
      && createError?.name !== 'BucketAlreadyExists') throw createError;
  }
}

await client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
