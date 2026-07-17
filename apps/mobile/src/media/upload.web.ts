import {
  MAX_UPLOAD_BYTES, MediaTooLargeError, requestUploadUrl, insertMediaRow,
  type UploadMediaInput, type UploadedMedia,
} from './uploadCore';

export { MAX_UPLOAD_BYTES, MediaTooLargeError } from './uploadCore';
export type { UploadMediaInput, UploadedMedia } from './uploadCore';

// Web variant of ./upload.ts (same exported surface — Metro resolves this file
// on web). No expo-file-system here: the upload streams the File/Blob straight
// to the presigned URL via fetch PUT, the same /media/upload-url + DB + outbox
// path the native helper uses, so the DB/sync contract is identical.
export async function uploadMediaAsset(input: UploadMediaInput): Promise<UploadedMedia> {
  let body: Blob | undefined = input.file;
  if (!body && input.uri) body = await (await fetch(input.uri)).blob();
  if (!body) throw new Error('Upload failed (no file).');

  const size = input.size ?? body.size;
  if (size > MAX_UPLOAD_BYTES) throw new MediaTooLargeError();

  const { uploadUrl, publicUrl, contentType } = await requestUploadUrl(input, size);

  // The Content-Type MUST equal the value the server signed (contentType),
  // or MinIO rejects with SignatureDoesNotMatch.
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}).`);
  }

  return insertMediaRow(input, publicUrl);
}
