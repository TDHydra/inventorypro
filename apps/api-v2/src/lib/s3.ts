import { S3Client } from '@aws-sdk/client-s3';

// Shared MinIO clients (extracted from routes/media.ts so lib/mediaCleanup.ts
// can delete objects from the sync path too).

// Fail closed: never fall back to default/guessable MinIO credentials.
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set (no default credentials)');
}
const credentials = { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY };

// Internal client — server↔MinIO operations (delete, etc.) over the private network.
export const s3 = new S3Client({
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  region: 'us-east-1',
  credentials,
  forcePathStyle: true,
});

// Signing client — presigned URLs the device uses must point at the PUBLIC MinIO
// host (e.g. https://s3.plexcontrol.com behind NPM), since the signature is bound
// to that host. Falls back to the internal endpoint for local/dev.
export const s3Public = new S3Client({
  endpoint: process.env.MINIO_PUBLIC_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  region: 'us-east-1',
  credentials,
  forcePathStyle: true,
});

export const BUCKET = process.env.MINIO_BUCKET ?? 'inventorypro';
