// Lightweight in-memory per-key rate limiter (the API runs as a single
// container). Used as a DOS guard on mutating endpoints — generous limits, not
// UX friction. Returns true when the caller is OVER the limit for this window.
const buckets = new Map<string, { count: number; reset: number }>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120; // 120 mutations / minute / user

export function overRateLimit(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > MAX_PER_WINDOW;
}

// Parameterized variant for per-endpoint limits: same bucket mechanics as
// overRateLimit but with a caller-supplied max (and optional window). Bucket
// entries are per-key, so distinct keys with different maxes coexist safely in
// the shared `buckets` map. Returns true when the caller is OVER `max` this window.
export function overLimit(key: string, max: number, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

// Periodic garbage collection: nothing above ever DELETES a bucket — an expired
// one is only replaced when the same key comes back, so one-off keys (e.g. a
// user's `mut:`/`refresh:` bucket after they stop calling) accumulate forever.
// Deletes every bucket whose window has already ended (now > reset); an active
// window is never dropped, so no in-flight count is lost. The map parameter
// exists for unit tests; production sweeps the module singleton.
export function sweepBuckets(
  now: number,
  map: Map<string, { count: number; reset: number }> = buckets,
): number {
  let removed = 0;
  for (const [key, b] of map) {
    if (now > b.reset) {
      map.delete(key);
      removed += 1;
    }
  }
  return removed;
}
