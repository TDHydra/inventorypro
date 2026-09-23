import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, PrimaryButton } from '@invenpro/ui';

/**
 * Quick Add launcher — a grid of actions. Every action routes to the single
 * dynamic `(app)/quickadd/[sheet]` screen (kind is the `sheet` param) instead
 * of its own file, so adding a new quick-add kind only means adding a row
 * here + a case in `[sheet].tsx` (see that file's KIND_META).
 *
 * Wave A shipped item/csv-import/stock/equipment/location; Waves B/C added
 * user/team/job/vehicle/gas-receipt. Only 'repair' remains a real, known kind
 * whose form isn't ported yet (repairs/ excluded, TODO(wave-D)) — old chooser
 * had no per-kind permission gating (only the overall `quick_add` gate
 * below), so there's no existing gating to mirror; its tile is just visually
 * disabled until that wave lands. `[sheet].tsx` still renders a themed
 * "coming soon" placeholder for it so a deep link / other push site isn't a
 * dead end.
 */
const ACTIONS: { kind: string; icon: string; label: string; sub: string; deferred?: boolean }[] = [
  { kind: 'item', icon: '📦', label: 'Item', sub: 'New catalog item' },
  { kind: 'csv-import', icon: '📋', label: 'Import CSV', sub: 'Bulk add items from a paste' },
  { kind: 'stock', icon: '➕', label: 'Stock', sub: 'Add stock to a location' },
  { kind: 'equipment', icon: '🛠️', label: 'Equipment', sub: 'New equipment + units' },
  { kind: 'location', icon: '📍', label: 'Location', sub: 'New location / shelf' },
  { kind: 'vehicle', icon: '🚐', label: 'Vehicle', sub: 'New vehicle' },
  { kind: 'gas-receipt', icon: '⛽', label: 'Gas Receipt', sub: 'Log a fuel-up' },
  { kind: 'job', icon: '🏗', label: 'Job', sub: 'New job' },
  // TODO(wave-D): repair quick add not ported yet (repairs/ excluded, out of
  // scope for Station C3 per the coordinator brief).
  { kind: 'repair', icon: '🔧', label: 'Repair', sub: 'Coming soon', deferred: true },
  { kind: 'team', icon: '👥', label: 'Team', sub: 'New team' },
  { kind: 'user', icon: '👤', label: 'User', sub: 'New employee account' },
];

export default function QuickAddLauncher() {
  const s = useThemedStyles(makeStyles);
  const canQuickAdd = usePermission('quick_add');
  const router = useRouter();

  if (!canQuickAdd) {
    return (
      <>
        <Stack.Screen options={{ title: 'Quick Add', headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>You don't have permission to quick add. Ask an admin to enable it for your role.</Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Quick Add', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <Text style={s.heading}>What do you want to add?</Text>
        <View style={s.grid}>
          {ACTIONS.map(a => (
            <TouchableOpacity
              key={a.kind}
              style={[s.card, a.deferred && s.cardDisabled]}
              activeOpacity={a.deferred ? 1 : 0.85}
              disabled={a.deferred}
              onPress={() => router.push(`/(app)/quickadd/${a.kind}`)}
            >
              <Text style={[s.cardIcon, a.deferred && s.cardIconDisabled]}>{a.icon}</Text>
              <Text style={[s.cardLabel, a.deferred && s.cardLabelDisabled]}>{a.label}</Text>
              <Text style={s.cardSub}>{a.sub}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg },
  heading: { fontSize: t.typography.fontSizes.md, fontWeight: '700', color: t.colors.textSecondary, marginBottom: t.spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md },
  card: {
    width: '47.5%',
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: t.spacing.lg,
    minHeight: 110,
    justifyContent: 'center',
  },
  cardDisabled: { opacity: 0.5 },
  cardIcon: { fontSize: 30, marginBottom: t.spacing.sm },
  cardIconDisabled: {},
  cardLabel: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.textPrimary },
  cardLabelDisabled: { color: t.colors.textMuted },
  cardSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxxl, backgroundColor: t.colors.background },
  gateTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  gateSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.xxl },
});
