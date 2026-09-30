// #188: pulled out of upload.web.ts as a standalone pure(ish) function — it has
// zero native-module imports (unlike uploadCore.ts, which pulls in db/schema,
// auth/session, ...), so it's directly unit-testable under `node --test`.
//
// Picks the bytes to PUT: the caller's already-picked File when present
// (preferred — a real File never goes stale), falling back to re-fetching the
// uri only when no File was threaded through. That fallback re-fetch is a
// `blob:` object URL from expo-image-picker's web shim, which CAN go stale
// (observed: launching the camera backgrounds the tab; a renderer/tab discard
// invalidates the blob: URL, and the re-fetch throws a generic
// `TypeError: Failed to fetch` indistinguishable from a real network failure)
// — so a failure here is rethrown with a message that names the actual cause.
export async function resolveUploadBody(input: { file?: File; uri?: string }): Promise<Blob> {
  if (input.file) return input.file;
  if (input.uri) {
    try {
      const res = await fetch(input.uri);
      return await res.blob();
    } catch {
      throw new Error('Photo data expired — please retake.');
    }
  }
  throw new Error('Upload failed (no file).');
}
