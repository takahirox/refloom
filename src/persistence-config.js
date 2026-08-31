import { PersistenceConfigError } from './persistence-errors.js';

const REQUIRED = [
  'DATABASE_URL',
  'REFLOOM_S3_ENDPOINT',
  'REFLOOM_S3_REGION',
  'REFLOOM_S3_BUCKET',
  'REFLOOM_S3_ACCESS_KEY_ID',
  'REFLOOM_S3_SECRET_ACCESS_KEY'
];

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceConfigError(`Missing required environment variable ${name}`, { variable: name });
  }
  return value;
}

function parseUrl(value, variable, protocols, credentialFree = false) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new PersistenceConfigError(`${variable} must be an absolute URL`, { variable }, { cause });
  }
  if (!protocols.includes(url.protocol)) {
    throw new PersistenceConfigError(`${variable} uses an unsupported protocol`, { variable });
  }
  if (!url.hostname || (credentialFree && (url.username || url.password))) {
    throw new PersistenceConfigError(`${variable} must be an absolute credential-free URL`, { variable });
  }
  return value;
}

function parseBoolean(value, variable) {
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new PersistenceConfigError(`${variable} must be exactly true or false`, { variable });
}

export function readPersistenceConfig(env = process.env) {
  for (const name of REQUIRED) required(env, name);
  const credentials = Object.freeze({
    accessKeyId: required(env, 'REFLOOM_S3_ACCESS_KEY_ID'),
    secretAccessKey: required(env, 'REFLOOM_S3_SECRET_ACCESS_KEY')
  });
  const s3 = Object.freeze({
    endpoint: parseUrl(required(env, 'REFLOOM_S3_ENDPOINT'), 'REFLOOM_S3_ENDPOINT', ['http:', 'https:'], true),
    region: required(env, 'REFLOOM_S3_REGION'),
    bucket: required(env, 'REFLOOM_S3_BUCKET'),
    forcePathStyle: parseBoolean(env.REFLOOM_S3_FORCE_PATH_STYLE, 'REFLOOM_S3_FORCE_PATH_STYLE'),
    credentials
  });
  return Object.freeze({
    databaseUrl: parseUrl(required(env, 'DATABASE_URL'), 'DATABASE_URL', ['postgres:', 'postgresql:']),
    s3
  });
}
