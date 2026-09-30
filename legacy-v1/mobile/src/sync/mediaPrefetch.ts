// Post-pull thumbnail warm-up. Media ROWS arrive via the regular incremental
// pull (every sync cycle, ≤60s on active devices); this fetches the new rows'
// thumbnails into the image cache right after, so an open gallery renders them
// with no loading flash. Opportunistic only — display never depends on it.
import { getDb } from '../db/schema';
import { getAppSetting, setAppSetting } from '../db/appSettings';
import { prefetchImage } from './prefetchImage';
import {
  MEDIA_PREFETCH_WATERMARK_KEY,
  PREFETCH_BATCH_LIMIT,
  SELECT_NEW_MEDIA_SQL,
  nextWatermark,
  pickPrefetchUrl,
  type PrefetchRow,
} from './mediaPrefetchRules';

function maxMediaTimestamp(): string | null {
  const rows = getDb().executeSync(
    `SELECT MAX(COALESCE(updated_at, created_at)) AS ts FROM media`,
  ).rows as { ts: string | null }[];
  return rows[0]?.ts ?? null;
}

/**
 * Initialize the watermark to "now-ish" (max media timestamp) WITHOUT
 * prefetching, so a freshly enrolled or freshly upgraded device never fetches
 * the entire thumbnail history. Called at the end of runFullDownload and
 * lazily by prefetchNewMediaThumbnails when the watermark is unset.
 */
export function initMediaPrefetchWatermark(): void {
  try {
    const max = maxMediaTimestamp();
    if (max) setAppSetting(MEDIA_PREFETCH_WATERMARK_KEY, max);
    // Empty media table: leave unset (pre-enrollment boot — the engine starts
    // before login; initializing here would be meaningless).
  } catch {
    // best-effort; next cycle retries
  }
}

let running = false;

/** Fire-and-forget from the sync cycle; must never throw. */
export async function prefetchNewMediaThumbnails(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const watermark = getAppSetting(MEDIA_PREFETCH_WATERMARK_KEY);
    if (!watermark) {
      initMediaPrefetchWatermark();
      return;
    }
    const rows = getDb().executeSync(
      SELECT_NEW_MEDIA_SQL, [watermark, PREFETCH_BATCH_LIMIT],
    ).rows as unknown as PrefetchRow[];
    if (rows.length === 0) return;

    const urls = rows.map(pickPrefetchUrl).filter((u): u is string => u !== null);
    await Promise.allSettled(urls.map(prefetchImage));
    // Advance past the whole batch regardless of fetch outcomes: a miss just
    // means one on-demand load later, and never re-fetching a dead URL every
    // cycle. Rows beyond the batch cap are picked up next cycle.
    setAppSetting(MEDIA_PREFETCH_WATERMARK_KEY, nextWatermark(rows, watermark));
  } catch {
    // never let cache warming break the sync cycle
  } finally {
    running = false;
  }
}
