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
//
// #203: a toast may also carry a single trailing `action` (e.g. "Request
// access") — still framework-free here, `onPress` is just a plain callback.
// The host is responsible for rendering it and for extending auto-dismiss
// while it's present (a user needs time to notice and tap a button, not just
// read a sentence).

// #203: an optional trailing action a toast can carry (e.g. "Request access"
// from a locked PermissionGate tap or a denied sync entry) — a single tappable
// button rendered at the toast's trailing edge. Tapping runs `onPress` AND
// dismisses the toast (the host never leaves a stale action toast hanging
// around after it's been acted on).
export interface ToastAction {
  label: string;
  onPress: () => void;
}

/**
 * Visual weight of the toast. 'default' is the quiet dark strip; 'success' is
 * a bold green confirmation (#218 feedback: "Saved — will sync" was too easy
 * to miss as a default toast). Purely presentational — the host maps it to
 * styles; the bus just carries it.
 */
export type ToastTone = 'default' | 'success';

export interface ToastRequest {
  id: number;
  message: string;
  /** Auto-dismiss delay in ms. Defaults to 3000 in the host (6000 when `action` is set — see ToastHost). */
  durationMs?: number;
  action?: ToastAction;
  tone?: ToastTone;
}

export interface ToastBus {
  push(req: { message: string; durationMs?: number; action?: ToastAction; tone?: ToastTone }): void;
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
    push({ message, durationMs, action, tone }): void {
      queue.push({ id: nextId++, message, durationMs, action, tone });
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
