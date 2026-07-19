import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { VehicleInlineStatus } from '../../../src/components/vehicles/VehicleInlineStatus';
import { VehicleSheet } from '../../../src/components/vehicles/VehicleSheet';
import { getVisibleUnits } from '../../../src/db/queries/access';
import { getUserById } from '../../../src/db/queries/users';
import { renderIcon } from '../../../src/constants/locationStyles';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

export default function VehiclesScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const refreshKey = useFocusOrDataRefresh();
  const { units, showsAll } = useMemo(
    () => (user ? getVisibleUnits(user, 'Vehicle') : { units: [], showsAll: false }),
    [user?.id, refreshKey],
  );
  // ⓘ target persists after close so ModalSheet's exit animation has a valid id.
  const [infoId, setInfoId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <>
      <Stack.Screen options={{ title: 'Vehicles', headerShown: true }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        {units.length === 0 ? (
          <EmptyState icon="🚐" title="No vehicles yet"
            subtitle="Vehicles you own, share a team with, or were granted access to show up here." />
        ) : (
          <>
            {showsAll && <Text style={s.caption}>Manager view — showing every vehicle.</Text>}
            {units.map(loc => (
              <TouchableOpacity key={loc.id} style={s.row}
                onPress={() => router.push({ pathname: '/(app)/(vehicles)/[id]', params: { id: loc.id } })}>
                <View style={s.rowMain}>
                  <Text style={s.rowName}>{loc.icon ? `${renderIcon(loc.icon)} ` : ''}{loc.name}</Text>
                  <Text style={s.rowSub}>{loc.owner_user_id ? getUserById(loc.owner_user_id)?.name ?? 'Owner' : 'No owner'}</Text>
                  <VehicleInlineStatus locationId={loc.id} />
                </View>
                <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => { setInfoId(loc.id); setInfoOpen(true); }}>
                  <Text style={s.info}>ⓘ</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </>
        )}
      </ScrollView>
      {infoId && <VehicleSheet locationId={infoId} visible={infoOpen} onClose={() => setInfoOpen(false)} />}
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, gap: t.spacing.sm, paddingBottom: 48 },
  caption: { fontSize: 12, color: t.colors.textMuted },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.surface,
    borderRadius: 12, borderWidth: 1, borderColor: t.colors.border, padding: t.spacing.base,
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  info: { fontSize: 18, color: t.colors.primary, paddingHorizontal: 6 },
});
