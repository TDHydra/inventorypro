import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

/**
 * Quick Add launcher — a grid of actions. Each action is its own screen under
 * (quickadd)/ so it can evolve independently. To add a new quick-add action:
 * create `(quickadd)/<thing>.tsx` (wrap your form in QuickAddScreenShell) and
 * add a row to ACTIONS below.
 */
const ACTIONS: { route: Href; icon: string; label: string; sub: string }[] = [
  { route: '/(app)/(quickadd)/item', icon: '📦', label: 'Item', sub: 'New catalog item' },
  { route: '/(app)/(quickadd)/csv-import', icon: '📋', label: 'Import CSV', sub: 'Bulk add items from a paste' },
  { route: '/(app)/(quickadd)/stock', icon: '➕', label: 'Stock', sub: 'Add stock to a location' },
  { route: '/(app)/(quickadd)/equipment', icon: '🛠️', label: 'Equipment', sub: 'New equipment + units' },
  { route: '/(app)/(quickadd)/location', icon: '📍', label: 'Location', sub: 'New location / shelf' },
  { route: '/(app)/(quickadd)/vehicle', icon: '🚐', label: 'Vehicle', sub: 'New vehicle' },
  { route: '/(app)/(quickadd)/job', icon: '🏗', label: 'Job', sub: 'New job' },
  { route: '/(app)/(quickadd)/repair', icon: '🔧', label: 'Repair', sub: 'Report a repair' },
  { route: '/(app)/(quickadd)/team', icon: '👥', label: 'Team', sub: 'New team' },
  { route: '/(app)/(quickadd)/user', icon: '👤', label: 'User', sub: 'New employee' },
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
            <TouchableOpacity key={String(a.route)} style={s.card} activeOpacity={0.85} onPress={() => router.push(a.route)}>
              <Text style={s.cardIcon}>{a.icon}</Text>
              <Text style={s.cardLabel}>{a.label}</Text>
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
  cardIcon: { fontSize: 30, marginBottom: t.spacing.sm },
  cardLabel: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.textPrimary },
  cardSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxxl, backgroundColor: t.colors.background },
  gateTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  gateSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.xxl },
});
