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

  // Size the picker-cache file so the server can enforce the 25 MB cap at
  // signing time (content_length); if it can't be statted, omit it.
  let size = input.size;
  if (size === undefined) {
    try {
      const info = await FileSystem.getInfoAsync(input.uri);
      if (info.exists && typeof info.size === 'number') size = info.size;
    } catch { /* size stays undefined */ }
  }
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
