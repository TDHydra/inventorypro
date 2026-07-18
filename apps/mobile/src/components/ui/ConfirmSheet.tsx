import { useEffect, useState, type ReactElement } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';
import { ModalSheet } from './ModalSheet';
import { PrimaryButton } from './PrimaryButton';

/**
 * Themed confirm bottom-sheet — a promise-based replacement for the ad-hoc
 * destructive-confirm plumbing in `src/lib/confirm.ts` / `src/lib/themedAlert.tsx`.
 *
 * Usage:
 *   import { confirmSheet } from '../../components/ui/ConfirmSheet';
 *   const ok = await confirmSheet({ title: 'Delete item?', destructive: true });
 *   if (ok) { ... }
 *
 * Mount `<ConfirmSheetHost />` once at the app root (alongside `<AlertHost />`)
 * — it renders whatever `confirmSheet()` pushes. Wired the same way as
 * `themedAlert.tsx`/`alertBus.ts`: a framework-free module-level queue
 * (`createConfirmQueue`, exported for testability) holds the queue/showing
 * state; this file only adds the React rendering on top.
 *
 * Resolves `false` on Cancel tap AND on backdrop/Android-back dismiss — a
 * pending promise is never left hanging. A second `confirmSheet()` call while
 * one is showing queues and resolves in the order it was requested.
 *
 * Existing call sites (`confirm.ts`, `Alert.alert`) are untouched by this file
 * — Wave C migrates screens to `confirmSheet()` one at a time.
 */

export interface ConfirmSheetOptions {
  title: string;
  message?: string;
  confirmLabel?: string; // default 'Confirm'
  cancelLabel?: string; // default 'Cancel'
  destructive?: boolean; // confirm button uses colors.danger / colors.dangerBg
}

interface ConfirmRequest extends ConfirmSheetOptions {
  resolve: (value: boolean) => void;
}

/**
 * Framework-free queue/showing state machine, mirroring `createAlertBus` in
 * `alertBus.ts`. Exported (beyond the module singleton below) so the
 * queueing/ordering behavior is unit-testable without React/RN.
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

/** The app-wide queue `ConfirmSheetHost` renders. Raise on it via `confirmSheet()`. */
const confirmQueue = createConfirmQueue();

/** Queue a themed confirm sheet; resolves `true` on confirm, `false` on cancel/backdrop dismiss. */
export function confirmSheet(opts: ConfirmSheetOptions): Promise<boolean> {
  return confirmQueue.push(opts);
}

/** Mount once at the app root (alongside `<AlertHost />`). */
export function ConfirmSheetHost(): ReactElement | null {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    confirmQueue.setListener(setReq);
    return () => { confirmQueue.setListener(null); };
  }, []);

  if (!req) return null;

  function settle(value: boolean) {
    setReq(null);
    confirmQueue.settle(value);
  }

  const confirmLabel = req.confirmLabel ?? 'Confirm';
  const cancelLabel = req.cancelLabel ?? 'Cancel';

  return (
    <ModalSheet visible onClose={() => settle(false)}>
      <Text style={s.title}>{req.title}</Text>
      {!!req.message && <Text style={s.message}>{req.message}</Text>}
      <View style={s.actions}>
        <TouchableOpacity style={s.btnGhost} onPress={() => settle(false)}>
          <Text style={s.btnGhostText}>{cancelLabel}</Text>
        </TouchableOpacity>
        <PrimaryButton
          label={confirmLabel}
          onPress={() => settle(true)}
          tone={req.destructive ? 'danger' : 'primary'}
          style={s.confirmBtn}
        />
      </View>
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary },
  message: { fontSize: fontSizes.body, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  btnGhost: {
    flex: 1,
    borderRadius: radii.lg,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnGhostText: { color: colors.textSecondary, fontWeight: '600', fontSize: fontSizes.base },
  confirmBtn: { flex: 1 },
});
