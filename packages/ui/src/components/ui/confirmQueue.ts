// Framework-free queue/showing state machine behind `ConfirmSheet.tsx`,
// mirroring `createAlertBus` in `alertBus.ts`. Kept in a plain (non-.tsx) file
// with zero react/react-native imports (precedent: quantityMath.ts,
// dateFieldLogic.ts) so the queueing/ordering behavior is unit-testable under
// node:test without pulling in RN's Flow-syntax internals via the tsx loader.

export interface ConfirmSheetOptions {
  title: string;
  message?: string;
  confirmLabel?: string; // default 'Confirm'
  cancelLabel?: string; // default 'Cancel'
  destructive?: boolean; // confirm button uses colors.danger / colors.dangerBg
}

export interface ConfirmRequest extends ConfirmSheetOptions {
  resolve: (value: boolean) => void;
}

/**
 * One request shows at a time; further `push()` calls queue and resolve in
 * request order. The host registers via `setListener` and reports the user's
 * choice via `settle`, which pumps the next queued request.
 */
export function createConfirmQueue() {
  let listener: ((req: ConfirmRequest | null) => void) | null = null;
  let current: ConfirmRequest | null = null;
  const queue: ConfirmRequest[] = [];

  function pump(): void {
    if (current || !listener || queue.length === 0) return;
    current = queue.shift()!;
    listener(current);
  }

  return {
    push(opts: ConfirmSheetOptions): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        queue.push({ ...opts, resolve });
        pump();
      });
    },
    /** The host registers here on mount (null on unmount); queued requests drain immediately. */
    setListener(fn: ((req: ConfirmRequest | null) => void) | null): void {
      listener = fn;
      pump();
    },
    /** The host calls this once the user resolves the showing request. */
    settle(value: boolean): void {
      if (!current) return;
      const req = current;
      current = null;
      req.resolve(value);
      pump();
    },
  };
}
