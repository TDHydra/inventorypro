// Pure request-shaping helpers for #180 external share (v1: RN core Share with
// a LINK only — no file attachment; expo-sharing arrives at the next native
// rebuild). Split from shareExternal.ts, which touches react-native's Share/
// Alert and auth/session — none of which parse under `node --test` without the
// Module._load stubbing dance uploadCore.test.ts needs. This half needs none of
// that, same split as media/upload.ts (native transport) vs media/uploadCore.ts
// (pure request/insert logic).

export function shareLinkEndpoint(apiBase: string, mediaId: string): string {
  return `${apiBase}/media/${encodeURIComponent(mediaId)}/share-link`;
}

// POST /media/:id/share-link replies { shareUrl, expiresInSeconds } on 200.
// Anything else — a non-2xx already filtered out by the caller, a malformed
// body, a missing/empty field — surfaces as null so the caller can show one
// friendly alert instead of leaking a raw parse error.
export function parseShareLinkBody(body: unknown): string | null {
  if (
    body !== null && typeof body === 'object' &&
    typeof (body as { shareUrl?: unknown }).shareUrl === 'string' &&
    (body as { shareUrl: string }).shareUrl.length > 0
  ) {
    return (body as { shareUrl: string }).shareUrl;
  }
  return null;
}
