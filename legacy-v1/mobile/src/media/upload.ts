// SDK 54+ moved uploadAsync to the /legacy entry point. BINARY_CONTENT streams
// the file straight to the presigned URL natively — avoids RN's "creating blobs
// from ArrayBuffer is not supported" error that fetch(uri).blob() + PUT hits.
import * as FileSystem from 'expo-file-system/legacy';
import {
  MAX_UPLOAD_BYTES, MediaTooLargeError, requestUploadUrl, insertMediaRow,
  type UploadMediaInput, type UploadedMedia,
} from './uploadCore';

export { MAX_UPLOAD_BYTES, MediaTooLargeError } from './uploadCore';
export type { UploadMediaInput, UploadedMedia } from './uploadCore';

// Native pick→upload-url→uploadAsync→insert flow (extracted from MediaGallery,
// shared with the chat composer). Throws on failure; on success the local media
// row exists and the matching outbox INSERT is queued.
export async function uploadMediaAsset(input: UploadMediaInput): Promise<UploadedMedia> {
  if (!input.uri) throw new Error('Upload failed (no file).');

  // Size the file we will actually STREAM (input.uri) so the server binds the
  // exact ContentLength into the presigned signature (#31-D2). Never prefer the
  // caller's declared size: gallery pickers report the ORIGINAL asset's bytes,
  // but quality<1 re-encodes into a different-sized cache file, and a signed
  // length that mismatches the streamed bytes is rejected by MinIO as
  // SignatureDoesNotMatch (403). Caller size is only a stat-failure fallback.
  let size: number | undefined;
  try {
    const info = await FileSystem.getInfoAsync(input.uri);
    if (info.exists && typeof info.size === 'number') size = info.size;
  } catch { /* fall through to the caller's declared size */ }
  if (size === undefined) size = input.size;
  if (size !== undefined && size > MAX_UPLOAD_BYTES) throw new MediaTooLargeError();

  const { uploadUrl, publicUrl, contentType } = await requestUploadUrl(input, size);

  // Upload directly to MinIO by streaming the file from disk (no JS Blob).
  // The Content-Type MUST equal the value the server signed (contentType),
  // or MinIO rejects with SignatureDoesNotMatch.
  const uploadRes = await FileSystem.uploadAsync(uploadUrl, input.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': contentType },
  });
  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(`Upload failed (${uploadRes.status}).`);
  }

  return insertMediaRow(input, publicUrl);
}
