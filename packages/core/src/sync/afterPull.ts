// Post-sync hook registries — the seam that replaces the old engine.ts
// hardcoded refresher block (reconcileTeams, the config caches, theme apply,
// alert checks, thumbnail prefetch, telemetry flush, …). The app registers its
// domain refreshers at startup; the engine just runs whatever is registered,
// so core never imports domain code.

export interface AfterPullHook {
  name: string;
  /** Runs after every successful drain+pull cycle. `changedTables` is the set
   *  the pull actually applied rows to (empty on a heartbeat pull). Async
   *  hooks are awaited in registration order; a hook that must not block the
   *  cycle should fire-and-forget internally and resolve immediately. */
  run(changedTables: Set<string>): void | Promise<void>;
  /** Optional filter: skip the hook when none of these tables changed. Omit to
   *  run every cycle (the old engine ran every refresher every cycle). */
  tables?: string[];
}

const afterPullHooks: AfterPullHook[] = [];

export function registerAfterPull(hook: AfterPullHook): () => void {
  afterPullHooks.push(hook);
  return () => {
    const i = afterPullHooks.indexOf(hook);
    if (i >= 0) afterPullHooks.splice(i, 1);
  };
}

export async function runAfterPullHooks(changedTables: Set<string>): Promise<void> {
  for (const hook of afterPullHooks) {
    if (hook.tables && !hook.tables.some(t => changedTables.has(t))) continue;
    try {
      await hook.run(changedTables);
    } catch (err) {
      // One broken refresher must not kill the rest of the cycle (matches the
      // old engine, where each refresher swallowed or void-ed its own errors).
      console.warn(`[Sync] afterPull hook '${hook.name}' failed:`, (err as Error).message);
    }
  }
}

// After-push hooks run each time a push batch has been applied to the outbox
// (ok/conflict verdicts recorded). The one legacy occupant is
// reconcileLogSyncState — activity_log is push-only, so its rows' synced_at
// only ever clears here.
const afterPushHooks: Array<{ name: string; run(): void }> = [];

export function registerAfterPush(name: string, run: () => void): () => void {
  const hook = { name, run };
  afterPushHooks.push(hook);
  return () => {
    const i = afterPushHooks.indexOf(hook);
    if (i >= 0) afterPushHooks.splice(i, 1);
  };
}

export function runAfterPushHooks(): void {
  for (const hook of afterPushHooks) {
    try {
      hook.run();
    } catch (err) {
      console.warn(`[Sync] afterPush hook '${hook.name}' failed:`, (err as Error).message);
    }
  }
}

/** Test-only: clear both registries between node:test cases. */
export function resetSyncHooksForTest(): void {
  afterPullHooks.length = 0;
  afterPushHooks.length = 0;
}
