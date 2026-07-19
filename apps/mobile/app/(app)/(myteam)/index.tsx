import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { runInTransaction } from '../../../src/db/tx';
import {
  getMyCrews, renameSubteam, setSubteamMembership, clearSubteamMembership, Crew,
} from '../../../src/db/queries/subteams';
import { getTeamMembers } from '../../../src/db/queries/teams';
import { getAccessibleSourceLocations } from '../../../src/db/queries/access';
import { getUnitAccessRows, revokeUnitAccess } from '../../../src/db/queries/unitAccess';
import { grantUnitAccessWithDefaults } from '../../../src/access/unitGrants';
import { getStockAtLocation, Location } from '../../../src/db/queries/locations';
import { getAllActiveUsers, getUserById } from '../../../src/db/queries/users';
import { getVehicle, VEHICLE_MODEL_CATEGORY } from '../../../src/db/queries/vehicles';
import { getTypeIcon } from '../../../src/db/queries/taxonomy';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../../src/constants/roles';
import { CrewCard } from '../../../src/components/crew/CrewCard';
import { CrewEditor, CrewDraft } from '../../../src/components/crew/CrewEditor';
import { AccessListEditor, AccessEntry } from '../../../src/components/crew/AccessListEditor';
import { LockerSheet } from '../../../src/components/lockers/LockerSheet';
import { VehicleSheet } from '../../../src/components/vehicles/VehicleSheet';
import { VehicleInlineStatus } from '../../../src/components/vehicles/VehicleInlineStatus';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// Manage My Team (#124) — a technician's home base for the things THEY are
// responsible for: the crew(s) they're in, the lockers they own (with the
// access list one tap away), and the vehicles they own. Everything routes
// through the shared embeddable surfaces (CrewCard/CrewEditor, LockerSheet +
// AccessListEditor, VehicleSheet) — this screen only assembles them.
//
// No requiredPermission gate: ownership/membership IS the gate (data-driven).
// A user with no crew and no owned assets gets a friendly EmptyState.

export default function ManageMyTeamScreen() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  // Re-query on sync pulls that touch our tables, plus a local bump after our
  // own writes (local writes don't tick dataVersion). Sheet-hosted edits
  // (LockerPanel's own access editor) also land on close via the bump there.
  const version = useTableVersion([
    'locations', 'unit_access', 'team_members', 'subteams', 'vehicles', 'vehicle_checkouts',
  ]);
  const [localBump, setLocalBump] = useState(0);
  const key = version + localBump;
  const bump = () => setLocalBump(b => b + 1);

  // ── Data ───────────────────────────────────────────────────────────────────

  const crews = useMemo<Crew[]>(
    () => (user ? getMyCrews(user.id) : []),
    [user?.id, key],
  );

  const accessible = useMemo(
    () => (user ? getAccessibleSourceLocations(user.id) : { lockers: [], vehicles: [] }),
    [user?.id, key],
  );
  // This page is about MY responsibilities — owned assets only (teammates'
  // lockers/vehicles show up in the fast-checkout source picker instead).
  const myLockers = useMemo(
    () => accessible.lockers.filter(l => l.owner_user_id === user?.id),
    [accessible, user?.id],
  );
  const myVehicles = useMemo(
    () => accessible.vehicles.filter(l => l.owner_user_id === user?.id),
    [accessible, user?.id],
  );

  const lockerRows = useMemo(
    () => myLockers.map(location => {
      const stock = getStockAtLocation(location.id);
      // People with access = me (owner) + explicit grants (minus an owner dupe).
      const grants = getUnitAccessRows(location.id).filter(g => g.user_id !== location.owner_user_id);
      return { location, itemCount: stock.length, accessCount: grants.length + 1 };
    }),
    [myLockers, key],
  );

  const vehicleRows = useMemo(
    () => myVehicles.map(location => {
      const model = getVehicle(location.id)?.model ?? null;
      return { location, model, icon: getTypeIcon(VEHICLE_MODEL_CATEGORY, model ?? '') ?? '🚐' };
    }),
    [myVehicles, key],
  );

  // ── Crew editing (lead only) ───────────────────────────────────────────────

  const [editingCrew, setEditingCrew] = useState<Crew | null>(null);
  const [showCrewEditor, setShowCrewEditor] = useState(false);

  // Assignable people = the crew's parent-team roster.
  const crewCandidates = useMemo<PickerOption[]>(() => {
    if (!editingCrew) return [];
    return getTeamMembers(editingCrew.teamId).map(m => ({
      id: m.user_id,
      label: m.user_name ?? m.user_id,
      sublabel: m.user_role ? (ROLE_DISPLAY_NAMES[m.user_role as UserRole] ?? m.user_role) : undefined,
    }));
  }, [editingCrew, key]);

  // Same diff-and-write shape as (teams)/[id].tsx handleSaveCrew (edit branch):
  // rename if changed, clear members who left, (re)assign only actual changes —
  // all in ONE transaction (the query layer joins it). Throwing keeps the
  // EntityEditSheet open.
  function handleSaveCrew(draft: CrewDraft) {
    const crew = editingCrew;
    if (!crew || isWriteBlocked()) throw new Error('write blocked');
    const actorId = user?.id ?? null;
    try {
      runInTransaction(() => {
        if (draft.name !== crew.name) {
          renameSubteam(crew.id, draft.name, actorId);
        }
        const beforeLead = crew.lead?.id ?? null;
        const beforeHelpers = new Set(crew.helpers.map(h => h.id));
        const after = new Set([draft.leadId, ...draft.helperIds]);
        for (const uid of [...(beforeLead ? [beforeLead] : []), ...beforeHelpers]) {
          if (!after.has(uid)) clearSubteamMembership(uid, crew.teamId, actorId);
        }
        if (beforeLead !== draft.leadId) {
          setSubteamMembership(crew.id, draft.leadId, 'lead', actorId);
        }
        for (const uid of draft.helperIds) {
          if (!beforeHelpers.has(uid)) {
            setSubteamMembership(crew.id, uid, 'helper', actorId);
          }
        }
      });
    } catch (e) {
      Alert.alert('Could not save crew', 'The crew was not saved. Please try again.');
      throw e;
    }
    bump();
  }

  // ── Locker access editing ──────────────────────────────────────────────────

  const [accessLocker, setAccessLocker] = useState<Location | null>(null);

  // Owner (me) is an implicit, non-removable entry; explicit grants follow —
  // mirrors LockerPanel's editor entries.
  const accessEntries = useMemo<AccessEntry[]>(() => {
    if (!accessLocker || !user) return [];
    const entries: AccessEntry[] = [
      { userId: user.id, name: user.name, sublabel: 'Owner', fixed: true },
    ];
    for (const g of getUnitAccessRows(accessLocker.id)) {
      if (g.user_id === user.id) continue;
      const grantedByName = g.granted_by ? getUserById(g.granted_by)?.name : null;
      entries.push({
        userId: g.user_id,
        name: g.user_name ?? g.user_id,
        sublabel: grantedByName ? `Granted by ${grantedByName}` : null,
      });
    }
    return entries;
  }, [accessLocker, user, key]);

  const accessCandidates = useMemo<PickerOption[]>(() => {
    if (!accessLocker) return [];
    const excluded = new Set(accessEntries.map(e => e.userId));
    return getAllActiveUsers()
      .filter(u => !excluded.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role as UserRole] ?? u.role }));
  }, [accessLocker, accessEntries, key]);

  // AccessListEditor owns the confirm/alert UX; throwing keeps it open.
  // Grant CREATION applies the admin's per-role defaults template (#122
  // Phase B); per-action edits happen in the unit's own access editors.
  function handleGrant(opt: PickerOption) {
    if (!accessLocker || isWriteBlocked()) throw new Error('write blocked');
    const grantee = getAllActiveUsers().find(u => u.id === opt.id);
    grantUnitAccessWithDefaults(accessLocker.id, opt.id, grantee?.role ?? '', user?.id ?? null);
    bump();
  }
  function handleRevoke(entry: AccessEntry) {
    if (!accessLocker || isWriteBlocked()) throw new Error('write blocked');
    revokeUnitAccess(accessLocker.id, entry.userId);
    bump();
  }

  // ── Sheets ─────────────────────────────────────────────────────────────────

  const [lockerSheetId, setLockerSheetId] = useState<string | null>(null);
  const [vehicleSheetId, setVehicleSheetId] = useState<string | null>(null);

  if (!user) return null; // (app)/_layout redirects to login

  const isEmpty = crews.length === 0 && lockerRows.length === 0 && vehicleRows.length === 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Manage My Team', headerShown: true }} />

      {isEmpty ? (
        <View style={s.center}>
          <EmptyState
            icon="🧰"
            title="Nothing to manage yet"
            subtitle="You're not in a crew and don't own a locker or vehicle yet. Crews and asset owners are set up by your manager."
          />
        </View>
      ) : (
        <ScrollView style={s.screen} contentContainerStyle={s.content}>
          {locked && <MaintenanceBanner />}

          {/* My Crews — edit affordance only where I'm the lead (courtesy gate;
              the server's manage_teams + per-team authority guard is the
              enforcement of record). */}
          {crews.length > 0 && (
            <>
              <Text style={s.sectionLabel}>My Crew{crews.length === 1 ? '' : 's'}</Text>
              {crews.map(crew => (
                <CrewCard
                  key={crew.id}
                  crew={crew}
                  right={crew.lead?.id === user.id ? (
                    <TouchableOpacity
                      onPress={() => { setEditingCrew(crew); setShowCrewEditor(true); }}
                      disabled={locked}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={locked && s.disabled}
                    >
                      <Text style={s.editLink}>Edit</Text>
                    </TouchableOpacity>
                  ) : undefined}
                />
              ))}
            </>
          )}

          {/* My Lockers — row opens the full LockerSheet; the trailing Access
              button jumps straight into the access list. */}
          {lockerRows.length > 0 && (
            <>
              <Text style={s.sectionLabel}>My Lockers</Text>
              <Card variant="detail" style={s.listCard}>
                {lockerRows.map((row, i) => (
                  <TouchableOpacity
                    key={row.location.id}
                    style={[s.assetRow, i < lockerRows.length - 1 && s.divider]}
                    onPress={() => setLockerSheetId(row.location.id)}
                    accessibilityLabel={`Open ${row.location.name}`}
                  >
                    <Text style={s.assetIcon}>🔒</Text>
                    <View style={s.assetBody}>
                      <Text style={s.assetName} numberOfLines={1}>{row.location.name}</Text>
                      <Text style={s.assetMeta}>
                        {row.itemCount} item{row.itemCount === 1 ? '' : 's'} · {row.accessCount} with access
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => setAccessLocker(row.location)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      accessibilityLabel={`Manage access to ${row.location.name}`}
                    >
                      <Text style={s.accessLink}>Access</Text>
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </Card>
            </>
          )}

          {/* My Vehicles — model icon + live status pills, tap for the sheet. */}
          {vehicleRows.length > 0 && (
            <>
              <Text style={s.sectionLabel}>My Vehicles</Text>
              <Card variant="detail" style={s.listCard}>
                {vehicleRows.map((row, i) => (
                  <TouchableOpacity
                    key={row.location.id}
                    style={[s.assetRow, i < vehicleRows.length - 1 && s.divider]}
                    onPress={() => setVehicleSheetId(row.location.id)}
                    accessibilityLabel={`Open ${row.location.name}`}
                  >
                    <Text style={s.assetIcon}>{row.icon}</Text>
                    <View style={s.assetBody}>
                      <Text style={s.assetName} numberOfLines={1}>{row.location.name}</Text>
                      {row.model ? <Text style={s.assetMeta}>{row.model}</Text> : null}
                      <VehicleInlineStatus locationId={row.location.id} />
                    </View>
                    <Text style={s.chevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </Card>
            </>
          )}
        </ScrollView>
      )}

      {/* Crew edit — validation + draft shape live in CrewEditor; handleSaveCrew
          above owns persistence (one transaction). */}
      <CrewEditor
        visible={showCrewEditor}
        onClose={() => setShowCrewEditor(false)}
        crew={editingCrew}
        candidates={crewCandidates}
        onSave={handleSaveCrew}
        disabled={locked}
      />

      {/* Straight-to-access editor from a locker row's Access button. */}
      <AccessListEditor
        visible={accessLocker !== null}
        onClose={() => setAccessLocker(null)}
        title={accessLocker ? `${accessLocker.name} · Access` : 'Access'}
        entries={accessEntries}
        candidates={accessCandidates}
        canEdit={!locked}
        onAdd={handleGrant}
        onRemove={handleRevoke}
        removeNoun="access to this locker"
      />

      {lockerSheetId !== null && (
        <LockerSheet
          locationId={lockerSheetId}
          visible
          onClose={() => { setLockerSheetId(null); bump(); }}
        />
      )}
      {vehicleSheetId !== null && (
        <VehicleSheet
          locationId={vehicleSheetId}
          visible
          onClose={() => { setVehicleSheetId(null); bump(); }}
        />
      )}
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, paddingBottom: 48, gap: t.spacing.sm },
  center: { flex: 1, justifyContent: 'center', backgroundColor: t.colors.background },

  sectionLabel: {
    fontSize: t.typography.fontSizes.xs, fontWeight: t.typography.weights.bold,
    color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: t.spacing.sm,
  },
  listCard: { paddingVertical: t.spacing.xs },

  assetRow: {
    flexDirection: 'row', alignItems: 'center', gap: t.spacing.md,
    paddingVertical: t.spacing.md,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  assetIcon: { fontSize: 22 },
  assetBody: { flex: 1 },
  assetName: {
    fontSize: t.typography.fontSizes.md, fontWeight: t.typography.weights.semibold,
    color: t.colors.textPrimary,
  },
  assetMeta: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted, marginTop: 2 },
  chevron: { fontSize: t.typography.fontSizes.md, color: t.colors.textMuted },

  editLink: { color: t.colors.primary, fontSize: t.typography.fontSizes.sm, fontWeight: t.typography.weights.bold },
  accessLink: { color: t.colors.primary, fontSize: t.typography.fontSizes.sm, fontWeight: t.typography.weights.bold },
  disabled: { opacity: 0.5 },
});
