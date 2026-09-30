// Pure rules for the post-pull media thumbnail prefetch (no DB imports so the
// module loads under `node --test`). The orchestrator lives in mediaPrefetch.ts.

export const PREFETCH_BATCH_LIMIT = 25;
export const MEDIA_PREFETCH_WATERMARK_KEY = 'media_prefetched_at';

// Oldest-first so the watermark advances monotonically; COALESCE because rows
// synced before migration 036 can have a null updated_at.
export const SELECT_NEW_MEDIA_SQL = `
  SELECT id, media_type, url, thumbnail_url, updated_at, created_at
  FROM media
  WHERE COALESCE(updated_at, created_at) > ?
  ORDER BY COALESCE(updated_at, created_at) ASC
  LIMIT ?`;

export interface PrefetchRow {
  media_type: string;
  url: string;
  thumbnail_url: string | null;
  updated_at: string | null;
  created_at: string;
}

// Warm exactly what the UI renders (`thumbnail_url ?? url`) — except never
// fetch a video binary: a video row without a thumbnail is skipped.
export function pickPrefetchUrl(row: Pick<PrefetchRow, 'media_type' | 'url' | 'thumbnail_url'>): string | null {
  if (row.thumbnail_url) return row.thumbnail_url;
  return row.media_type === 'image' ? row.url : null;
}

// Watermark after a batch attempt: max timestamp of the SELECTED rows,
// regardless of individual fetch outcomes (prefetch is opportunistic cache
// warming — advancing past failures keeps 404s/offline blips self-terminating).
export function nextWatermark(rows: Array<Pick<PrefetchRow, 'updated_at' | 'created_at'>>, current: string): string {
  let max = current;
  for (const r of rows) {
    const ts = r.updated_at ?? r.created_at;
    if (ts > max) max = ts;
  }
  return max;
}
