// Framework-free state machine behind `ToastHost` — the queue/showing logic
// lives here so it is unit-testable, mirroring `createAlertBus` (alertBus.ts)
// and `createConfirmQueue` (components/ui/confirmQueue.ts). Kept in a plain
// (non-.tsx) file with zero react/react-native imports (same precedent as
// confirmQueue.ts) so it runs under plain node:test.
//
// A toast is a transient, non-blocking snackbar (bottom of screen, themed,
// auto-dismisses on its own) — unlike AlertHost/ConfirmSheetHost it is NEVER a
// Modal, so it can surface while a sheet/modal is open without stacking a
// second visible overlay (#197: "Requires <permission>" fires from a tap on a
// disabled tile, which may itself sit under an open sheet).

export interface ToastRequest {
  id: number;
  message: string;
  /** Auto-dismiss delay in ms. Defaults to 3000 in the host. */
  durationMs?: number;
}

export interface ToastBus {
  push(req: { message: string; durationMs?: number }): void;
  /** The host registers here on mount (null on unmount); queued requests drain immediately. */
  setListener(fn: ((req: ToastRequest | null) => void) | null): void;
  /** The host calls this once its auto-dismiss timer (or a tap) closes the toast. */
  notifyDismissed(): void;
}

export function createToastBus(): ToastBus {
  let listener: ((req: ToastRequest | null) => void) | null = null;
  let current: ToastRequest | null = null;
  let nextId = 1;
  const queue: ToastRequest[] = [];

  function pump(): void {
    if (current || !listener || queue.length === 0) return;
    current = queue.shift()!;
    listener(current);
  }

  return {
    push({ message, durationMs }): void {
      queue.push({ id: nextId++, message, durationMs });
      pump();
    },
    setListener(fn): void {
      listener = fn;
      pump();
    },
    notifyDismissed(): void {
      current = null;
      pump();
    },
  };
}

/** The app-wide bus `ToastHost` renders. Raise on it from non-React modules. */
export const appToastBus = createToastBus();
