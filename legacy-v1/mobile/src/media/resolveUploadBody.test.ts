import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUploadBody } from './resolveUploadBody';

// A minimal Blob-like stand-in — plain `node --test` has no DOM File/Blob
// constructors loaded by default, but resolveUploadBody only ever touches
// what it's handed, never `new File(...)` itself.
function fakeFile(): File {
  return { name: 'photo.jpg', size: 123 } as unknown as File;
}

test('resolveUploadBody: prefers input.file when present, never touches fetch', async () => {
  const file = fakeFile();
  const origFetch = globalThis.fetch;
  // @ts-expect-error — test double
  globalThis.fetch = () => { throw new Error('fetch should not be called'); };
  try {
    const body = await resolveUploadBody({ file, uri: 'blob:should-be-ignored' });
    assert.equal(body, file);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resolveUploadBody: falls back to fetch(uri).blob() when no file is given', async () => {
  const fakeBlob = { size: 456 } as unknown as Blob;
  const origFetch = globalThis.fetch;
  // @ts-expect-error — test double
  globalThis.fetch = async (uri: string) => {
    assert.equal(uri, 'blob:ok');
    return { blob: async () => fakeBlob } as unknown as Response;
  };
  try {
    const body = await resolveUploadBody({ uri: 'blob:ok' });
    assert.equal(body, fakeBlob);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// #188: this is the actual regression — a stale/discarded blob: URL throws a
// generic TypeError from fetch, indistinguishable from a real network error.
// The fallback must rethrow a message that names the real cause.
test('resolveUploadBody: fallback fetch failure is rethrown as "Photo data expired"', async () => {
  const origFetch = globalThis.fetch;
  // @ts-expect-error — test double
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await assert.rejects(
      () => resolveUploadBody({ uri: 'blob:stale' }),
      (err: Error) => err.message === 'Photo data expired — please retake.',
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('resolveUploadBody: no file and no uri throws "no file"', async () => {
  await assert.rejects(
    () => resolveUploadBody({}),
    (err: Error) => err.message === 'Upload failed (no file).',
  );
});
