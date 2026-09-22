import { View, Text, StyleSheet } from 'react-native';
import { Stack, Redirect, useRouter, useLocalSearchParams } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, PrimaryButton } from '@invenpro/ui';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';
import ItemQuickAdd from '../../../src/components/quickadd/ItemQuickAdd';
import LocationQuickAdd from '../../../src/components/quickadd/LocationQuickAdd';
import StockQuickAdd from '../../../src/components/quickadd/StockQuickAdd';
import EquipmentQuickAdd from '../../../src/components/quickadd/EquipmentQuickAdd';
import UserQuickAdd from '../../../src/components/quickadd/UserQuickAdd';
import CsvImport from '../../../src/components/CsvImport';

/**
 * Single dynamic route replacing the old app's 11 per-kind
 * `(app)/(quickadd)/<kind>.tsx` wrapper screens (each just mounted a sheet
 * component through QuickAddScreenShell). `sheet` is the kind; unknown kinds
 * redirect back to the chooser.
 *
 * Wave A kinds (item/location/stock/equipment/csv-import) render their real
 * form. Everything else is a known-but-not-yet-built kind — the chooser tile
 * is disabled, but this route still renders a themed "coming soon" placeholder
 * so a deep link or another push site isn't a dead end.
 */
const KIND_TITLES: Record<string, string> = {
  item: 'Quick Add — Item',
  location: 'Quick Add — Location',
  stock: 'Quick Add — Stock',
  equipment: 'Quick Add — Equipment',
  'csv-import': 'Quick Add — Import CSV',
  user: 'Quick Add — User',
  // TODO(wave-B)
  team: 'Quick Add — Team',
  // TODO(wave-C)
  vehicle: 'Quick Add — Vehicle',
  repair: 'Quick Add — Repair',
  'gas-receipt': 'Quick Add — Gas Receipt',
  job: 'Quick Add — Job',
};

export default function QuickAddSheetScreen() {
  const { sheet } = useLocalSearchParams<{ sheet: string }>();
  const title = sheet ? KIND_TITLES[sheet] : undefined;

  if (!title) return <Redirect href="/(app)/quickadd" />;

  switch (sheet) {
    case 'item':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <ItemQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'location':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <LocationQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'stock':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <StockQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'equipment':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <EquipmentQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'csv-import':
      return (
        <QuickAddScreenShell title={title}>
          {onSaved => <CsvImport onImported={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'user':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <UserQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    // TODO(wave-B): TeamQuickAdd not ported this wave (a later Wave B station owns teams).
    case 'team':
    // TODO(wave-C): VehicleQuickAdd / RepairQuickAdd / GasReceiptQuickAdd /
    // JobQuickAdd not ported this wave.
    case 'vehicle':
    case 'repair':
    case 'gas-receipt':
    case 'job':
      return <ComingSoonPlaceholder title={title} />;
    default:
      return <Redirect href="/(app)/quickadd" />;
  }
}

function ComingSoonPlaceholder({ title }: { title: string }) {
  const s = useThemedStyles(makeStyles);
  const canQuickAdd = usePermission('quick_add');
  const router = useRouter();

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

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <View style={s.gate}>
        <Text style={s.gateTitle}>Coming soon</Text>
        <Text style={s.gateSub}>{title.replace('Quick Add — ', '')} quick add lands in a later wave.</Text>
        <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxxl, backgroundColor: t.colors.background },
  gateTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  gateSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.xxl },
});
