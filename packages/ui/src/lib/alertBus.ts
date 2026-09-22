/**
 * Framework-free state machine behind `themedAlert` — the queue/showing logic
 * lives here so it is unit-testable; `AlertHost` (React) just renders whatever
 * the bus delivers and reports dismissals back.
 *
 * Requests carry an optional `tag` so code elsewhere can programmatically
 * dismiss a specific alert (e.g. any touch dismisses the `idle-nudge` warning)
 * without being able to swat arbitrary dialogs.
 */

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface AlertButton {
  text?: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
}

export interface AlertRequest {
  title: string;
  message?: string;
  buttons: AlertButton[];
  tag?: string;
}

export interface AlertBus {
  alert(req: { title: string; message?: string; buttons?: AlertButton[]; tag?: string }): void;
  /** The host registers here on mount (null on unmount); queued requests drain immediately. */
  setListener(fn: ((req: AlertRequest | null) => void) | null): void;
  /** The host calls this after the user closes the current dialog. */
  notifyDismissed(): void;
  /** Dismiss the showing alert iff its tag matches; returns whether it did. */
  dismissActive(tag: string): boolean;
}

function normalize(buttons?: AlertButton[]): AlertButton[] {
  if (!buttons || buttons.length === 0) return [{ text: 'OK', style: 'default' }];
  return buttons;
}

/** Tag for the pre-logout inactivity warning — any user touch dismisses it. */
export const IDLE_NUDGE_TAG = 'idle-nudge';

export function createAlertBus(): AlertBus {
  let listener: ((req: AlertRequest | null) => void) | null = null;
  let current: AlertRequest | null = null;
  const queue: AlertRequest[] = [];

  function pump(): void {
    if (current || !listener || queue.length === 0) return;
    current = queue.shift()!;
    listener(current);
  }

  return {
    alert({ title, message, buttons, tag }): void {
      // A tagged alert that is already showing or queued is not stacked again
      // (the idle nudge re-fires on every warn timer; one dialog is enough).
      if (tag && (current?.tag === tag || queue.some((q) => q.tag === tag))) return;
      queue.push({ title, message, buttons: normalize(buttons), tag });
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
    dismissActive(tag): boolean {
      if (!current || current.tag !== tag) return false;
      current = null;
      listener?.(null);
      pump();
      return true;
    },
  };
}

/** The app-wide bus `AlertHost` renders. Raise on it from non-React modules. */
export const appAlertBus = createAlertBus();
