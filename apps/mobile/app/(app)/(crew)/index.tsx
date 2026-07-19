/**
 * Fast-checkout source picker (#127) — "Where are you working from?"
 *
 * Cards for every locker/vehicle the signed-in user can check out from
 * (getAccessibleSourceLocations: owned ∪ granted ∪ owned by a parent-team
 * mate). Tapping a card — or having exactly one accessible source — drops
 * straight into the hub with {loc, scan:'1'}: camera up, browse scoped, and
 * plain check-outs committed from that source with no DestinationPicker.
 * Also hosts the #84 "Add a vehicle" button when the org flag is on and the
 * device is physically at a known site (useVehicleIntake).
 */
import { useEffect, useMemo, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { VehicleInlineStatus } from '../../../src/components/vehicles/VehicleInlineStatus';
import { getCheckoutSourceLocations } from '../../../src/db/queries/access';
import { getStockAtLocation, type Location } from '../../../src/db/queries/locations';
import { getUserById } from '../../../src/db/queries/users';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { useVehicleIntake } from '../../../src/hooks/useVehicleIntake';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

export default function CrewSourcePickerScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const refreshKey = useFocusOrDataRefresh();
  // #83: the same picker drives fast check-IN when dir=in ("return to your
  // locker/vehicle") — same accessible-source list, opposite hub direction.
  const params = useLocalSearchParams<{ dir?: string }>();
  const checkin = params.dir === 'in';

  // #139: main Locations join lockers/vehicles as a first-class source type,
  // but only for users whose role can check inventory out (units are access-
  // gated inside the query; main locations have no per-object ACL so the role
  // gate is the only guard). Check-in reuses the same sources.
  const canCheckout = usePermission('checkout_inventory');
  const sources = useMemo(
    () => (user ? getCheckoutSourceLocations(user.id) : { locations: [], lockers: [], vehicles: [] }),
    [user?.id, refreshKey],
  );
  const locations = canCheckout ? sources.locations : [];
  const total = locations.length + sources.lockers.length + sources.vehicles.length;

  // #84 gate — re-resolve flag + proximity on every focus/sync bump so walking
  // on-site (or an admin flipping the flag) shows the button without a restart.
  const intake = useVehicleIntake();
  const intakeRefresh = intake.refresh;
  useEffect(() => { intakeRefresh(); }, [refreshKey, intakeRefresh]);
  const showAddVehicle = intake.enabled && !!intake.nearbyLocation;

  // Always replace: whether auto-advanced or tapped, "back" from the hub
  // should skip re-asking the question and land wherever the user came from.
  function goToHub(loc: Location) {
    router.replace({
      pathname: '/(app)/(hub)',
      params: { loc: loc.id, scan: '1', ...(checkin ? { dir: 'in' } : null) },
    });
  }

  // Exactly one accessible source → no question to ask, replace straight into
  // the hub (back skips this screen). Guarded so a focus-refresh can't bounce.
  const autoAdvanced = useRef(false);
  const only = total === 1 ? (locations[0] ?? sources.lockers[0] ?? sources.vehicles[0]) : null;
  useEffect(() => {
    if (only && !autoAdvanced.current) {
      autoAdvanced.current = true;
      goToHub(only);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only?.id]);

  return (
    <>
      <Stack.Screen options={{ title: checkin ? 'Check in' : 'Check out', headerShown: true }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        {only ? null : total === 0 ? (
          <EmptyState
            icon="🔑"
            title="No locker or vehicle access yet"
            subtitle="You can check in or out from a locker or vehicle once its owner or a manager gives you access — or when a teammate on your team owns one."
          />
        ) : (
          <>
            <Text style={s.prompt}>{checkin ? 'Where are you returning to?' : 'Where are you working from?'}</Text>
            {locations.length > 0 && (
              <>
                <Text style={s.sectionHeader}>Locations</Text>
                {locations.map(loc => (
                  <SourceCard key={loc.id} location={loc} onPress={() => goToHub(loc)} />
                ))}
              </>
            )}
            {sources.lockers.length > 0 && (
              <>
                <Text style={s.sectionHeader}>Lockers</Text>
                {sources.lockers.map(loc => (
                  <SourceCard key={loc.id} location={loc} onPress={() => goToHub(loc)} />
                ))}
              </>
            )}
            {sources.vehicles.length > 0 && (
              <>
                <Text style={s.sectionHeader}>Vehicles</Text>
                {sources.vehicles.map(loc => (
                  <SourceCard key={loc.id} location={loc} onPress={() => goToHub(loc)} />
                ))}
              </>
            )}
          </>
        )}

        {showAddVehicle && (
          <View style={s.addVehicleWrap}>
            {intake.nearbyLocation && (
              <Text style={s.addVehicleNote}>You're at {intake.nearbyLocation.name}.</Text>
            )}
            <PrimaryButton
              label="＋ Add a vehicle"
              onPress={() => router.push('/(app)/(quickadd)/vehicle')}
            />
          </View>
        )}
      </ScrollView>
    </>
  );
}

function SourceCard({ location, onPress }: { location: Location; onPress: () => void }) {
  const s = useThemedStyles(makeStyles);
  const isVehicle = location.type === 'Vehicle';
  const isUnit = isVehicle || location.type === 'Locker';
  // Owner + stock count re-read whenever the parent re-renders (its refreshKey
  // recomputed the source list) — cheap single-row/single-location queries.
  const owner = location.owner_user_id ? getUserById(location.owner_user_id) : null;
  const stock = getStockAtLocation(location.id);
  const defaultIcon = isVehicle ? '🚐' : location.type === 'Locker' ? '🔒' : '📍';
  const itemCount = `${stock.length} item${stock.length === 1 ? '' : 's'}`;

  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.cardIcon}>{location.icon || defaultIcon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.cardName} numberOfLines={1}>{location.name}</Text>
        <Text style={s.cardSub} numberOfLines={1}>
          {/* Main locations have no owner concept — show stock only. */}
          {isUnit ? `${owner ? owner.name : 'No owner'} · ${itemCount}` : itemCount}
        </Text>
        {isVehicle && <VehicleInlineStatus locationId={location.id} />}
      </View>
      <Text style={s.cardChevron}>›</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, paddingBottom: 48 },
  prompt: {
    fontSize: 18, fontWeight: '700', color: t.colors.textPrimary,
    marginBottom: t.spacing.sm,
  },
  sectionHeader: {
    fontSize: 12, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: t.spacing.base, marginBottom: t.spacing.xs,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
    backgroundColor: t.colors.surface, padding: t.spacing.base,
    borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    marginBottom: t.spacing.sm,
  },
  cardIcon: { fontSize: 26 },
  cardName: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary },
  cardSub: { fontSize: 13, color: t.colors.textMuted, marginTop: 2 },
  cardChevron: { fontSize: 22, color: t.colors.textMuted },
  addVehicleWrap: { marginTop: t.spacing.xl, gap: t.spacing.xs },
  addVehicleNote: { fontSize: 12, color: t.colors.textMuted, textAlign: 'center' },
});
