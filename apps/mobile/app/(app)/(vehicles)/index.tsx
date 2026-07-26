import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { SegmentedControl } from '../../../src/components/ui/SegmentedControl';
import { VehicleInlineStatus } from '../../../src/components/vehicles/VehicleInlineStatus';
import { VehicleSheet } from '../../../src/components/vehicles/VehicleSheet';
import { getVisibleUnits, getTeamUnits } from '../../../src/db/queries/access';
import { isVehicleAvailableForCheckout, getActiveCheckout } from '../../../src/db/queries/vehicles';
import { getUserById } from '../../../src/db/queries/users';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
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
  const { units: allUnits, showsAll } = useMemo(
    () => (user ? getVisibleUnits(user, 'Vehicle') : { units: [], showsAll: false }),
    [user?.id, refreshKey],
  );
  // #157 made getVisibleUnits return EVERY vehicle for everyone; the "Team
  // Vehicles" segment restores the pre-#157 accessible set (kernel-only, no
  // all-vehicles bypass) as the default so the list isn't cluttered.
  const teamUnits = useMemo(
    () => (user ? getTeamUnits(user, 'Vehicle') : []),
    [user?.id, refreshKey],
  );
  // null = user hasn't touched the control; managers (showsAll) default to All.
  const [segmentChoice, setSegmentChoice] = useState<'team' | 'all' | 'available' | null>(null);
  // Empty team set falls back to All (and the control reflects it).
  const segment = segmentChoice === 'team' && teamUnits.length === 0
    ? 'all'
    : segmentChoice ?? (teamUnits.length === 0 || showsAll ? 'all' : 'team');
  // #155: the checkable set — availability + the #167 lock, per caller.
  const tableKey = useTableVersion(['vehicles', 'vehicle_checkouts']);
  const availableUnits = useMemo(
    () => (segment === 'available'
      ? allUnits.filter(l => isVehicleAvailableForCheckout(l.id, user?.id ?? null))
      : []),
    [segment, allUnits, user?.id, refreshKey, tableKey],
  );
  const units = segment === 'team' ? teamUnits : segment === 'available' ? availableUnits : allUnits;
  // ⓘ target persists after close so ModalSheet's exit animation has a valid id.
  const [infoId, setInfoId] = useState<string | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <>
      <Stack.Screen options={{ title: 'Vehicles', headerShown: true }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        {allUnits.length > 0 && (
          <SegmentedControl
            segments={[
              { id: 'team', label: 'Team Vehicles' },
              { id: 'all', label: 'All Vehicles' },
              { id: 'available', label: 'Available' },
            ]}
            value={segment}
            onChange={id => setSegmentChoice(id as 'team' | 'all' | 'available')}
          />
        )}
        {units.length === 0 ? (
          segment === 'available' ? (
            <EmptyState icon="🚐" title="No vehicles available"
              subtitle="Nothing is free to check out right now — owned vehicles appear here when their owner opts in." />
          ) : (
            <EmptyState icon="🚐" title="No vehicles yet"
              subtitle="Vehicles you own, share a team with, or were granted access to show up here." />
          )
        ) : (
          <>
            {showsAll && segment === 'all' && <Text style={s.caption}>Manager view — showing every vehicle.</Text>}
            {units.map(loc => {
              // #168 review follow-up: mark rows the CALLER can't check out
              // right now (owned-closed, locked against them, or held by
              // someone else). Your own held vehicle isn't "locked" to you.
              const unavailable =
                !isVehicleAvailableForCheckout(loc.id, user?.id ?? null)
                && getActiveCheckout(loc.id)?.user_id !== user?.id;
              return (
              <TouchableOpacity key={loc.id} style={s.row}
                onPress={() => router.push({ pathname: '/(app)/(vehicles)/[id]', params: { id: loc.id } })}>
                <View style={s.rowMain}>
                  <Text style={s.rowName}>{loc.icon ? `${renderIcon(loc.icon)} ` : ''}{loc.name}{unavailable ? ' 🔒' : ''}</Text>
                  <Text style={s.rowSub}>{loc.owner_user_id ? getUserById(loc.owner_user_id)?.name ?? 'Owner' : 'No owner'}</Text>
                  <VehicleInlineStatus locationId={loc.id} />
                </View>
                <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => { setInfoId(loc.id); setInfoOpen(true); }}>
                  <Text style={s.info}>ⓘ</Text>
                </TouchableOpacity>
              </TouchableOpacity>
              );
            })}
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
