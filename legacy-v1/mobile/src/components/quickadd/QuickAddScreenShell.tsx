import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../hooks/usePermission';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FormScreen } from '../ui/FormScreen';
import { Toast } from '../ui/Toast';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { QuickAddEditSheet } from './QuickAddEditSheet';
import type { JustAddedRef, QuickAddSaveMeta } from './justAdded';

// Cap how many "added this session" rows carry an edit affordance so a long
// session doesn't grow an unbounded list — only the most recent few are likely
// to still need a quick correction.
const MAX_RECENT = 5;

interface RecentEntry {
  key: string;
  label: string;
  ref?: JustAddedRef;
}

/**
 * Shared chrome for a single Quick Add action screen: the `quick_add` permission
 * gate (deep-link safe), the screen header, a confirmation toast, a per-session
 * counter, and — for entity kinds that support it (item / equipment unit / stock)
 * — a small "added this session" list with an Edit affordance so a mistake can be
 * fixed inline instead of jumping to the full screen. The *form* itself stays in
 * each screen (render-prop `children(onSaved)`) so every action can diverge
 * freely without touching this shell.
 */
export function QuickAddScreenShell({
  title,
  children,
  wrapForm = true,
}: {
  title: string;
  children: (onSaved: (label: string, createdId?: string, meta?: QuickAddSaveMeta) => void) => React.ReactNode;
  /**
   * Default: the shell wraps children in FormScreen (#118). Pass `false` when
   * the form renders its OWN FormScreen — required for forms that pin their
   * save actions in FormScreen's sticky `footer` slot (QuickAddFooter), since
   * the footer must be a sibling of the scroll area, not scroll content.
   */
  wrapForm?: boolean;
}) {
  const s = useThemedStyles(makeStyles);
  const canQuickAdd = usePermission('quick_add');
  // Editing item/unit fields and adjusting stock are all gated behind
  // edit_inventory on their full screens — mirror that here rather than
  // inventing a separate quick-add-only permission. Deactivating an item is its
  // own, stricter permission (some roles have edit_inventory but not
  // delete_inventory — see ROLE_DEFAULTS), so it's checked separately below.
  const canEdit = usePermission('edit_inventory');
  const canDeleteItems = usePermission('delete_inventory');
  // Stock adjust/undo hits the server's ADJUST path, which requires checkin OR
  // checkout (NOT edit_inventory) — gate the stock sheet on the same perm the
  // server enforces, or a permission_overrides combo would silently stick the
  // outbox entry ("Forbidden: stock adjust requires checkin/checkout").
  const canAdjustStock = usePermission('checkin_inventory') || usePermission('checkout_inventory');
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [editingRef, setEditingRef] = useState<JustAddedRef | null>(null);

  if (!canQuickAdd) {
    return (
      <>
        <Stack.Screen options={{ title, headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>You don't have permission to quick add. Ask an admin to enable it for your role.</Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  function onSaved(label: string, createdId?: string, meta?: QuickAddSaveMeta) {
    setCount(c => c + 1);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(`Added ${label}`);
    toastTimer.current = setTimeout(() => setToast(null), 2000);

    // Only entities whose kind we recognize get an edit affordance; everything
    // else still shows in the toast/counter above but has no `ref` here.
    let ref: JustAddedRef | undefined;
    if (meta?.kind === 'item' && createdId) ref = { kind: 'item', id: createdId };
    else if (meta?.kind === 'equipment_unit' && createdId) ref = { kind: 'equipment_unit', id: createdId };
    else if (meta?.kind === 'stock') {
      ref = { kind: 'stock', itemId: meta.itemId, locationId: meta.locationId, qty: meta.qty, mode: meta.mode, unit: meta.unit };
    }

    const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setRecent(prev => [{ key, label, ref }, ...prev].slice(0, MAX_RECENT));
  }

  // Whether the current user can do *anything* (edit and/or delete) with a given
  // just-added entity — used to decide whether its row gets an Edit affordance
  // at all. The sheet itself re-checks per-action (an item row shows if only
  // delete_inventory is granted, but "Save" stays hidden without edit_inventory).
  function canManage(ref: JustAddedRef): boolean {
    if (ref.kind === 'item') return canEdit || canDeleteItems;
    if (ref.kind === 'stock') return canAdjustStock;
    return canEdit;
  }

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      {/* Non-scrolling chrome (toast / counter / recent list) stays pinned above
          the FormScreen; only the form area scrolls + is keyboard-aware (#118). */}
      <View style={s.container}>
        {toast !== null && <Toast message={toast} />}
        {count > 0 && (
          <View style={s.counterRow}><Text style={s.counterText}>Added {count} this session</Text></View>
        )}
        {recent.some(r => r.ref && canManage(r.ref)) && (
          <View style={s.recentList}>
            {recent.map(r => r.ref && canManage(r.ref) && (
              <View key={r.key} style={s.recentRow}>
                <Text style={s.recentLabel} numberOfLines={1}>{r.label}</Text>
                <TouchableOpacity style={s.recentEditBtn} onPress={() => setEditingRef(r.ref!)}>
                  <Text style={s.recentEditText}>Edit</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
        {wrapForm ? (
          <FormScreen contentContainerStyle={s.content}>
            {children(onSaved)}
          </FormScreen>
        ) : (
          children(onSaved)
        )}
      </View>
      <QuickAddEditSheet
        visible={editingRef !== null}
        entityRef={editingRef}
        canEdit={canEdit}
        canDeleteItems={canDeleteItems}
        canAdjustStock={canAdjustStock}
        onClose={() => setEditingRef(null)}
        onSaved={(label, patch) => {
          setRecent(prev => prev.map(r => (r.ref === editingRef && r.ref
            ? { ...r, label, ref: patch ? ({ ...r.ref, ...patch } as JustAddedRef) : r.ref }
            : r)));
          setEditingRef(null);
        }}
        onDeleted={() => {
          setRecent(prev => prev.filter(r => r.ref !== editingRef));
          setEditingRef(null);
        }}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  counterRow: { paddingHorizontal: t.spacing.lg, paddingBottom: 6, paddingTop: 6, alignItems: 'center' },
  counterText: { fontSize: t.typography.fontSizes.caption, color: t.colors.success, fontWeight: '700' },
  recentList: { paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.sm, gap: 6 },
  recentRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm,
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, paddingVertical: 8,
  },
  recentLabel: { flex: 1, fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary },
  recentEditBtn: { paddingHorizontal: t.spacing.sm, paddingVertical: 4 },
  recentEditText: { fontSize: t.typography.fontSizes.caption, color: t.colors.primaryText, fontWeight: '700' },
  content: { padding: t.spacing.lg, paddingBottom: 48 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxxl, backgroundColor: t.colors.background },
  gateTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  gateSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.xxl },
});
