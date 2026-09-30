// #227: pure tally for the This Week activity digest widget — count log rows
// by action, most frequent first (alphabetical tiebreak so equal counts don't
// reshuffle between renders). Kept DB/React-free for node tests.

export const DIGEST_TOP_N = 6;

export function tallyActions(
  rows: { action: string }[],
  top: number = DIGEST_TOP_N,
): { action: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  return [...counts.entries()]
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
    .slice(0, top);
}
