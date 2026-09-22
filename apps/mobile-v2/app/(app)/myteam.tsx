// Ported from apps/mobile/app/(app)/(myteam)/index.tsx (plain route, was a
// parenthesized group; renamed index.tsx → myteam.tsx to mirror the old
// route's own URL segment now that there's no group folder to carry the name).
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../src/db/queries/subteams' + '../../src/db/queries/teams' →
//     '../../src/repos/teams' (Station B2 merged teams/team_members/subteams
//     into one repo file).
//   '../../src/db/tx' (runInTransaction) → '@invenpro/core'
//   '../../src/hooks/useDataVersion' (useTableVersion) → '@invenpro/core'
//   ui/* components, useThemedStyles, Alert → '@invenpro/ui'
//
// Cut for this station (see docs/REBUILD-NOTES.md Wave B section) — "Manage
// My Team" (#124) was a technician's home base for crew + owned lockers +
// owned vehicles.
//   - My Lockers restored in Station B3, SIMPLIFIED: the old LockerSheet
//     (full LockerPanel + "Open full page" route) is cut — tapping a locker
//     here opens AccessListEditor directly (grant/revoke who can access it),
//     since a dedicated locker detail route isn't part of this wave.
//   - My Vehicles (VehicleSheet, VehicleInlineStatus, vehicles table) —
//     TODO(wave-C): vehicles aren't ported yet at all.
// isEmpty is keyed on crews.length alone — My Lockers renders (possibly
// empty) below My Crews regardless, mirroring the old app's layout.
import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { Alert, useThemedStyles, EmptyState, MaintenanceBanner } from '@invenpro/ui';
import type { Theme } from '@invenpro/ui';
import { useTableVersion, runInTransaction } from '@invenpro/core';
import { useSession } from '../../src/hooks/useSession';
import { useMaintenanceMode } from '../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../src/db/maintenance';
import {
  getMyCrews, getTeamMembers, renameSubteam, setSubteamMembership, clearSubteamMembership,
  type Crew,
} from '../../src/repos/teams';
import { appendLog } from '../../src/db/queries/log';
import { ROLE_DISPLAY_NAMES } from '../../src/constants/roles';
import type { UserRole } from '../../src/constants/roles';
import { CrewCard } from '../../src/components/crew/CrewCard';
import { CrewEditor, type CrewDraft } from '../../src/components/crew/CrewEditor';
import type { PickerOption } from '../../src/components/SearchablePicker';
import { getLocationsByOwner } from '../../src/repos/locations';
import { getAllActiveUsers } from '../../src/repos/users';
import {
  getUnitAccessRows, revokeUnitAccess, grantUnitAccessWithDefaults,
} from '../../src/repos/access';
import { AccessListEditor, type AccessEntry } from '../../src/components/crew/AccessListEditor';

// Manage My Team (#124, scoped down) — a technician's home base for the crew(s)
// they're in. Everything routes through the shared CrewCard/CrewEditor — this
// screen only assembles them.
//
// No requiredPermission gate: crew membership IS the gate (data-driven). A
// user with no crew gets a friendly EmptyState.
export default function ManageMyTeamScreen() {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Re-query on any change (sync pull OR our own local writes — both tick the
  // table version bus) that touches the tables this screen reads.
  const version = useTableVersion(['team_members', 'subteams', 'users']);

  const crews = useMemo<Crew[]>(
    () => (user ? getMyCrews(user.id) : []),
    [user?.id, version],
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
  }, [editingCrew, version]);

  // Same diff-and-write shape as teams/[id].tsx's handleSaveCrew (edit
  // branch): rename if changed, clear members who left, (re)assign only
  // actual changes — all in ONE transaction (the repo layer joins it).
  // repos/teams.ts's subteam functions don't self-log (see teams/[id].tsx's
  // header comment for why) — every appendLog below is this screen's own
  // responsibility, ported from the old app's db/queries/subteams.ts.
  function handleSaveCrew(draft: CrewDraft) {
    const crew = editingCrew;
    if (!crew || isWriteBlocked()) throw new Error('write blocked');
    const actorId = realUser?.id ?? null;
    try {
      runInTransaction(() => {
        if (draft.name !== crew.name) {
          const { oldName } = renameSubteam(crew.id, draft.name);
          appendLog({
            user_id: actorId, team_id: crew.teamId, action: 'subteam_updated',
            entity_type: 'team', entity_id: crew.teamId,
            from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
            note: `${oldName} → ${draft.name}`,
            metadata: JSON.stringify({ subteam_id: crew.id, renamed: true }),
            device_id: null,
          });
        }
        const beforeLead = crew.lead?.id ?? null;
        const beforeHelpers = new Set(crew.helpers.map(h => h.id));
        const after = new Set([draft.leadId, ...draft.helperIds]);
        for (const uid of [...(beforeLead ? [beforeLead] : []), ...beforeHelpers]) {
          if (!after.has(uid)) {
            const cleared = clearSubteamMembership(crew.teamId, uid);
            if (cleared) {
              appendLog({
                user_id: actorId, team_id: crew.teamId, action: 'subteam_updated',
                entity_type: 'team', entity_id: crew.teamId,
                from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
                note: null,
                metadata: JSON.stringify({ member_user_id: uid, subteam_cleared: true }),
                device_id: null,
              });
            }
          }
        }
        if (beforeLead !== draft.leadId) {
          const { name } = setSubteamMembership(crew.id, draft.leadId, 'lead');
          appendLog({
            user_id: actorId, team_id: crew.teamId, action: 'subteam_updated',
            entity_type: 'team', entity_id: crew.teamId,
            from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
            note: name,
            metadata: JSON.stringify({ subteam_id: crew.id, member_user_id: draft.leadId, subteam_role: 'lead' }),
            device_id: null,
          });
        }
        for (const uid of draft.helperIds) {
          if (!beforeHelpers.has(uid)) {
            const { name } = setSubteamMembership(crew.id, uid, 'helper');
            appendLog({
              user_id: actorId, team_id: crew.teamId, action: 'subteam_updated',
              entity_type: 'team', entity_id: crew.teamId,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: name,
              metadata: JSON.stringify({ subteam_id: crew.id, member_user_id: uid, subteam_role: 'helper' }),
              device_id: null,
            });
          }
        }
      });
    } catch (e) {
      Alert.alert('Could not save crew', 'The crew was not saved. Please try again.');
      throw e;
    }
  }

  // ── My Lockers (#146 owned lockers, restored Station B3) ───────────────────
  // Simplified vs. the old LockerSheet: tapping a locker opens AccessListEditor
  // directly (who can access it), not a full LockerPanel.

  const myLockers = useMemo(
    () => (user ? getLocationsByOwner(user.id).filter(l => l.type === 'Locker' && l.active === 1) : []),
    [user?.id, version],
  );

  const [accessLockerId, setAccessLockerId] = useState<string | null>(null);
  const accessLocker = myLockers.find(l => l.id === accessLockerId) ?? null;

  const lockerGrants = useMemo(
    () => (accessLockerId ? getUnitAccessRows(accessLockerId) : []),
    [accessLockerId, version],
  );
  const lockerEntries = useMemo<AccessEntry[]>(
    () => lockerGrants.map(g => ({ userId: g.user_id, name: g.user_name ?? g.user_id })),
    [lockerGrants],
  );
  const lockerCandidates = useMemo<PickerOption[]>(() => {
    if (!accessLockerId) return [];
    const already = new Set(lockerGrants.map(g => g.user_id));
    return getAllActiveUsers()
      .filter(u => u.id !== user?.id && !already.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role ? (ROLE_DISPLAY_NAMES[u.role as UserRole] ?? u.role) : undefined }));
  }, [accessLockerId, lockerGrants, user?.id]);

  // grantUnitAccessWithDefaults/revokeUnitAccess (repos/access.ts) don't
  // self-log (Station B3 convention) — this screen owns the appendLog calls,
  // matching the shapes documented in repos/access.ts.
  function handleGrantLockerAccess(opt: PickerOption) {
    if (!accessLocker || isWriteBlocked()) return;
    const actorId = realUser?.id ?? null;
    runInTransaction(() => {
      grantUnitAccessWithDefaults(accessLocker.id, opt.id, opt.sublabel ?? '', actorId);
      appendLog({
        action: 'unit_access_granted', entity_type: 'location', entity_id: accessLocker.id,
        user_id: actorId, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({ grantee_user_id: opt.id }),
        device_id: null,
      });
    });
  }

  function handleRevokeLockerAccess(entry: AccessEntry) {
    if (!accessLocker || isWriteBlocked()) return;
    runInTransaction(() => {
      revokeUnitAccess(accessLocker.id, entry.userId);
      appendLog({
        action: 'unit_access_revoked', entity_type: 'location', entity_id: accessLocker.id,
        user_id: null, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({ grantee_user_id: entry.userId }),
        device_id: null,
      });
    });
  }

  if (!user) return null; // (app)/_layout redirects to login

  const isEmpty = crews.length === 0 && myLockers.length === 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Manage My Team', headerShown: true }} />

      {isEmpty ? (
        <View style={s.center}>
          <EmptyState
            icon="🧰"
            title="Nothing to manage yet"
            subtitle="You're not in a crew yet. Crews are set up by your manager."
          />
        </View>
      ) : (
        <ScrollView style={s.screen} contentContainerStyle={s.content}>
          {locked && <MaintenanceBanner />}

          {/* My Crews — edit affordance only where I'm the lead (courtesy gate;
              the server's manage_teams + per-team authority guard is the
              enforcement of record). */}
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
                  style={locked ? s.disabled : undefined}
                >
                  <Text style={s.editLink}>Edit</Text>
                </TouchableOpacity>
              ) : undefined}
            />
          ))}

          {myLockers.length > 0 && (
            <>
              <Text style={s.sectionLabel}>My Locker{myLockers.length === 1 ? '' : 's'}</Text>
              {myLockers.map(l => (
                <TouchableOpacity
                  key={l.id}
                  style={s.lockerRow}
                  onPress={() => setAccessLockerId(l.id)}
                  disabled={locked}
                >
                  <Text style={s.lockerName}>🔒 {l.name}</Text>
                  <Text style={s.editLink}>Manage access</Text>
                </TouchableOpacity>
              ))}
            </>
          )}

          {/* TODO(wave-C): My Vehicles section cut — vehicles aren't ported yet. */}
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

      {/* Who can access my locker — simplified stand-in for the old LockerSheet
          (no full LockerPanel this wave, see header comment). */}
      <AccessListEditor
        visible={!!accessLockerId}
        onClose={() => setAccessLockerId(null)}
        title={accessLocker ? `Access — ${accessLocker.name}` : 'Access'}
        entries={lockerEntries}
        candidates={lockerCandidates}
        canEdit={!locked}
        onAdd={handleGrantLockerAccess}
        onRemove={handleRevokeLockerAccess}
        removeNoun="locker access"
      />
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

  editLink: { color: t.colors.primary, fontSize: t.typography.fontSizes.sm, fontWeight: t.typography.weights.bold },
  disabled: { opacity: 0.5 },

  lockerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.base, paddingVertical: 12,
  },
  lockerName: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600' },
});
