// Guard registry. Per-row policies stay CODE (plan: registerTableGuard) —
// guards are registered ONCE, in guards/index.ts, in the same relative order
// the old monolith evaluated them; runPhase preserves that order so rejection
// precedence is unchanged.
import type { GuardVerdict, OutboxEntry, Rejection, SyncCtx, TableGuard } from './types';

const guards: TableGuard[] = [];

export function registerTableGuard(guard: TableGuard): void {
  guards.push(guard);
}

/** Test seam: not used in production. */
export function clearTableGuards(): void {
  guards.length = 0;
}

function applies(g: TableGuard, entry: OutboxEntry): boolean {
  return g.table === '*' || g.table === entry.table_name;
}

export async function runPreAuthorize(ctx: SyncCtx, entry: OutboxEntry): Promise<Rejection | undefined> {
  for (const g of guards) {
    if (!g.preAuthorize || !applies(g, entry)) continue;
    const verdict = await g.preAuthorize(ctx, entry);
    if (verdict) return verdict;
  }
  return undefined;
}

export async function runPrivileged(ctx: SyncCtx, entry: OutboxEntry): Promise<Rejection | undefined> {
  for (const g of guards) {
    if (!g.privileged || !applies(g, entry)) continue;
    const verdict = await g.privileged(ctx, entry);
    if (verdict) return verdict;
  }
  return undefined;
}

export async function runAuthorizeRow(ctx: SyncCtx, entry: OutboxEntry): Promise<GuardVerdict> {
  for (const g of guards) {
    if (!g.authorizeRow || !applies(g, entry)) continue;
    const verdict = await g.authorizeRow(ctx, entry);
    if (verdict) return verdict;
  }
  return undefined;
}

export async function runAfterApply(ctx: SyncCtx, entry: OutboxEntry): Promise<void> {
  for (const g of guards) {
    if (!g.afterApply || !applies(g, entry)) continue;
    await g.afterApply(ctx, entry);
  }
}
