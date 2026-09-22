import { useEffect, useState, type ReactElement } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { ModalSheet } from './ModalSheet';
import { PrimaryButton } from './PrimaryButton';
import { createConfirmQueue, type ConfirmRequest, type ConfirmSheetOptions } from './confirmQueue';

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
 * (`createConfirmQueue` in `confirmQueue.ts`, re-exported here) holds the
 * queue/showing state; this file only adds the React rendering on top.
 *
 * Resolves `false` on Cancel tap AND on backdrop/Android-back dismiss — a
 * pending promise is never left hanging. A second `confirmSheet()` call while
 * one is showing queues and resolves in the order it was requested.
 *
 * Existing call sites (`confirm.ts`, `Alert.alert`) are untouched by this file
 * — Wave C migrates screens to `confirmSheet()` one at a time.
 */

// The queue itself lives in `confirmQueue.ts` (a pure, react-free module so it
// runs under plain `node --test`); re-exported here so existing importers keep
// working.
export { createConfirmQueue } from './confirmQueue';
export type { ConfirmSheetOptions, ConfirmRequest } from './confirmQueue';

/** The app-wide queue `ConfirmSheetHost` renders. Raise on it via `confirmSheet()`. */
const confirmQueue = createConfirmQueue();

/** Queue a themed confirm sheet; resolves `true` on confirm, `false` on cancel/backdrop dismiss. */
export function confirmSheet(opts: ConfirmSheetOptions): Promise<boolean> {
  return confirmQueue.push(opts);
}

/** Mount once at the app root (alongside `<AlertHost />`). */
export function ConfirmSheetHost(): ReactElement | null {
  const s = useThemedStyles(makeStyles);
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    confirmQueue.setListener(setReq);
    return () => { confirmQueue.setListener(null); };
  }, []);

  if (!req) return null;

  function settle(value: boolean) {
    setReq(null);
    // Resolve AFTER the modal tears down (next macrotask), mirroring AlertHost:
    // if the awaiting caller navigates while this <Modal> is still mounted, its
    // lingering native window sits on top of the pushed screen and swallows
    // touches until manually dismissed.
    setTimeout(() => confirmQueue.settle(value), 0);
  }

  const confirmLabel = req.confirmLabel ?? 'Confirm';
  const cancelLabel = req.cancelLabel ?? 'Cancel';

  return (
    <ModalSheet visible onClose={() => settle(false)}>
      <Text style={s.title}>{req.title}</Text>
      {!!req.message && <Text style={s.message}>{req.message}</Text>}
      <View style={s.actions}>
        <TouchableOpacity style={s.btnGhost} onPress={() => settle(false)} accessibilityRole="button" accessibilityLabel={cancelLabel}>
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

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  message: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, marginTop: t.spacing.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.xl },
  btnGhost: {
    flex: 1,
    borderRadius: t.radii.lg,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  btnGhostText: { color: t.colors.textSecondary, fontWeight: '600', fontSize: t.typography.fontSizes.base },
  confirmBtn: { flex: 1 },
});
