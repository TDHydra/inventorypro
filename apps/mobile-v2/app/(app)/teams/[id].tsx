// Ported from apps/mobile/app/(app)/(teams)/[id].tsx (plain route, was a
// parenthesized group).
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/teams' (teams) + '../../../src/db/queries/subteams'
//     (subteams) → both merged into '../../../src/repos/teams' (one repo file
//     for teams + team_members + subteams, Station B2).
//   '../../../src/sync/outbox' (appendOutbox) → dropped; every write here
//     self-mirrors via repos/teams.ts (createRepository('teams'/'team_members'/
//     'subteams')).
//   '../../../src/db/tx' (runInTransaction) → '@invenpro/core'
//   '../../../src/db/queries/users' (getAllActiveUsers) → '../../../src/repos/users'
//   '../../../src/db/queries/users' (roleColor, getRoleColorMap) →
//     '../../../src/repos/roleSettings'
//   '../../../src/db/queries/taxonomy' (getTypeIcon) → '../../../src/repos/taxonomy'
//   '../../../src/lib/themedAlert' (Alert), ui/* components, confirmSheet,
//     useThemedStyles → '@invenpro/ui'
//
// Cut for this wave (coordinator's cut-list / unported domains — see
// docs/REBUILD-NOTES.md Wave B section):
//   - Message member / DM (TODO(wave-chat) — chat isn't ported yet).
// MemberPermissionsSheet's per-unit access grants + personal locker sections
// were restored in Station B3 (repos/access.ts + access/personalLocker.ts).
//
// repos/teams.ts's subteam functions (createSubteam/renameSubteam/
// setSubteamMembership/clearSubteamMembership/deleteSubteam) don't call
// appendLog internally (repos never do, per the B1/TeamQuickAdd convention) —
// unlike the old app's db/queries/subteams.ts, which logged inside the query
// layer. So handleSaveCrew/handleDeleteCrew below now own those appendLog
// calls, using the {team_id, name/oldName, memberUserIds} the repo functions
// return for exactly that purpose.
import { useState, useMemo, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useThemedStyles, Card, EmptyState, KeyValueRow, confirmSheet,
  ModalSheet, EntityEditSheet, PrimaryButton, AppInput, MaintenanceBanner,
} from '@invenpro/ui';
import { runInTransaction } from '@invenpro/core';
import {
  getTeamById, getTeamMembers, updateTeam, addTeamMember, removeTeamMember,
  setMemberManagerOnline, getSubteamsForTeam, createSubteam, renameSubteam,
  deleteSubteam, setSubteamMembership, clearSubteamMembership,
  type Team, type TeamMember, type Crew,
} from '../../../src/repos/teams';
import { CrewCard } from '../../../src/components/crew/CrewCard';
import { CrewEditor, type CrewDraft } from '../../../src/components/crew/CrewEditor';
import { MemberPermissionsSheet } from '../../../src/components/crew/MemberPermissionsSheet';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { getAllActiveUsers } from '../../../src/repos/users';
import { roleColor, getRoleColorMap } from '../../../src/repos/roleSettings';
import { ROLE_DISPLAY_NAMES, ROLE_TIER, canActOnTarget } from '../../../src/constants/roles';
import type { UserRole } from '../../../src/constants/roles';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getTypeIcon } from '../../../src/repos/taxonomy';
import { TaxonomyChips } from '../../../src/components/pickers';
import { QuickCreateSheet } from '../../../src/components/quickadd/QuickCreateSheet';
import { validateName } from '../../../src/lib/validation';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { track } from '../../../src/telemetry';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'team_detail', props: { field, rule } });
}

export default function TeamDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, realUser } = useSession();
  // #197/#198: previously this screen only checked team membership/org
  // authority (the deep-link guard below) — a role with view_teams
  // unchecked still saw teams it belonged to. Gate on the permission first,
  // before the membership check even runs.
  const canView = usePermission('view_teams');
  const { locked } = useMaintenanceMode();

  const [team, setTeam] = useState<Team | null>(() => getTeamById(id));
  const [members, setMembers] = useState<TeamMember[]>(() => getTeamMembers(id));
  const [crews, setCrews] = useState<Crew[]>(() => getSubteamsForTeam(id));

  // Re-read team + roster on focus or sync pull so a stale foreign team (still held
  // before reconcileTeams runs) or a server-side manager demotion self-corrects
  // once the next pull applies — the disables below are courtesy, not enforcement.
  const refreshKey = useFocusOrDataRefresh();
  useEffect(() => {
    setTeam(getTeamById(id));
    setMembers(getTeamMembers(id));
    setCrews(getSubteamsForTeam(id));
  }, [id, refreshKey]);

  // Membership resolved from the AUTHENTICATED caller's own team_members row, never
  // the payload. is_manager here can lag the server: a manager demoted server-side
  // keeps is_manager=1 locally until the next pull (we re-read on focus or sync
  // pull, above).
  const myMembership = useMemo(
    () => members.find(m => m.user_id === user?.id) ?? null,
    [members, user?.id],
  );
  const isMember = myMembership !== null;
  const isManager = myMembership?.is_manager === 1;
  // Org authority is a TIER test (>= 3), mirroring the server's isOrgAuthority and the
  // list screen — deliberately NOT the manage_teams permission: tier-3 office/hr
  // managers are org authority yet lack manage_teams, while tier-2 leads hold
  // manage_teams but are not org authority. Unknown roles fail closed.
  const isOrgAuthority = !!user && (ROLE_TIER[user.role] ?? 0) >= 3;

  // Who may act on the roster: org authority (full) or this team's managers. A plain
  // member sees the roster read-only (no controls). manage_teams is NOT the gate.
  const canManageRoster = isOrgAuthority || isManager;
  // Courtesy gray-out only — NOT enforcement. A team manager without org authority may
  // not appoint/demote managers, remove themselves, or rename/delete the team; those
  // controls are disabled here, but the server guard (routes/teams.ts + /sync/push) is
  // the enforcement of record.
  const managerRestricted = isManager && !isOrgAuthority;

  // Edit modal
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');

  // Add member modal
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberOption, setNewMemberOption] = useState<PickerOption | null>(null);

  // Inline user-create from the member picker
  const [showUserCreate, setShowUserCreate] = useState(false);

  // Crew (subteam) editor — `crew` null = create, set = edit (#123)
  const [showCrewEditor, setShowCrewEditor] = useState(false);
  const [editingCrew, setEditingCrew] = useState<Crew | null>(null);

  // Per-member permission editor (team overrides) — the sheet itself is
  // MemberPermissionsSheet; this screen only picks the member.
  const [permMember, setPermMember] = useState<TeamMember | null>(null);

  const allUsers = useMemo(() => getAllActiveUsers(), [refreshKey]);
  const roleColors = useMemo(() => getRoleColorMap(), [refreshKey]);
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );

  // Managers are members flagged is_manager (multi-manager model). Read is_manager,
  // NOT a deprecated teams.manager_id column (there isn't one here).
  const managers = useMemo(() => members.filter(m => m.is_manager === 1), [members]);

  // Users not already on the team (for Add Member picker)
  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members]);
  const nonMemberOptions = useMemo<PickerOption[]>(
    () => userOptions.filter(o => !memberIds.has(o.id)),
    [userOptions, memberIds],
  );

  // ── Edit team ──────────────────────────────────────────────────────────────

  function openEdit() {
    if (!team) return;
    setEditName(team.name);
    setEditType(team.type);
    setShowEdit(true);
  }

  // EntityEditSheet contract: throw on any failure so the sheet stays open;
  // returning normally closes it.
  function handleSaveEdit() {
    if (!team || isWriteBlocked()) throw new Error('write blocked');
    const trimmed = editName.trim();
    if (!trimmed) {
      trackReject('team.name', 'required');
      Alert.alert('Required', 'Enter a team name.');
      throw new Error('validation: name required');
    }
    // Bounded + control-char-free (the blank case above keeps its original copy).
    const nameResult = validateName(trimmed, { label: 'Team name' });
    if (!nameResult.ok) {
      trackReject('team.name', nameResult.rule);
      Alert.alert('Invalid name', nameResult.error);
      throw new Error('validation: name invalid');
    }
    let now: string;
    try {
      runInTransaction(() => {
        now = updateTeam(team, trimmed, editType);
        appendLog({
          user_id: realUser?.id ?? null,
          team_id: team.id,
          action: 'team_updated',
          entity_type: 'team',
          entity_id: team.id,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          job_id: null,
          note: null,
          metadata: null,
          device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not save team', 'The changes were not saved. Please try again.');
      throw e;
    }
    // Success side-effects only after the write committed; the sheet closes itself.
    setTeam({ ...team, name: trimmed, type: editType, updated_at: now! });
  }

  // ── Add member ─────────────────────────────────────────────────────────────

  function handleAddMember() {
    if (!newMemberOption || !team) return;
    if (isWriteBlocked()) return;
    let result: ReturnType<typeof addTeamMember>;
    try {
      result = runInTransaction(() => {
        const r = addTeamMember(team.id, newMemberOption.id, {}, realUser?.id ?? null);
        if (r === null) {
          // Composite key already exists (already a member); no outbox/log churn —
          // addTeamMember() itself skips the outbox row on a no-op.
          return null;
        }
        appendLog({
          user_id: realUser?.id ?? null,
          team_id: team.id,
          action: 'team_member_added',
          entity_type: 'team',
          entity_id: team.id,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          job_id: null,
          note: newMemberOption.label,
          metadata: JSON.stringify({ member_user_id: newMemberOption.id }),
          device_id: null,
        });
        return r;
      });
    } catch (e) {
      Alert.alert('Could not add member', `${newMemberOption.label} was not added. Please try again.`);
      return;
    }
    if (result === null) {
      Alert.alert('Already a member', `${newMemberOption.label} is already on this team.`);
      setNewMemberOption(null);
      setShowAddMember(false);
      return;
    }
    // Success side-effects only after the write committed.
    setMembers(getTeamMembers(team.id));
    setNewMemberOption(null); // clear only after successful submit
    setShowAddMember(false);
  }

  // ── Remove member ──────────────────────────────────────────────────────────

  async function handleRemoveMember(member: TeamMember) {
    if (!team) return;
    if (isWriteBlocked()) return;
    const memberName = member.user_name ?? member.user_id;
    const ok = await confirmSheet({
      title: 'Remove Member',
      message: `Remove ${memberName} from this team?`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      runInTransaction(() => {
        removeTeamMember(team.id, member.user_id);
        appendLog({
          user_id: realUser?.id ?? null,
          team_id: team.id,
          action: 'team_member_removed',
          entity_type: 'team',
          entity_id: team.id,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          job_id: null,
          note: memberName,
          metadata: JSON.stringify({ member_user_id: member.user_id }),
          device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not remove member', `${memberName} was not removed. Please try again.`);
      return;
    }
    // Refresh only after the write committed.
    setMembers(getTeamMembers(team.id));
  }

  // ── Promote / demote manager ────────────────────────────────────────────────

  // is_manager is server-controlled (sync ignores it — was a self-promotion hole),
  // so promotion goes through the gated PATCH endpoint online, then reflects
  // locally. Online-only, like creating a user.
  async function handleToggleManager(member: TeamMember) {
    if (!team) return;
    const willBeManager = member.is_manager !== 1;
    const memberName = member.user_name ?? member.user_id;
    try {
      await setMemberManagerOnline(team.id, member.user_id, willBeManager);
      // Activity log is best-effort (and never blocks the change).
      try {
        appendLog({
          user_id: realUser?.id ?? null,
          team_id: team.id,
          action: willBeManager ? 'team_manager_added' : 'team_manager_removed',
          entity_type: 'team',
          entity_id: team.id,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          job_id: null,
          note: memberName,
          metadata: JSON.stringify({ member_user_id: member.user_id }),
          device_id: null,
        });
      } catch { /* logging is non-critical */ }
    } catch (e) {
      Alert.alert('Could not update manager', (e as Error).message);
      return;
    }
    // Refresh only after the server confirmed + local row updated.
    setMembers(getTeamMembers(team.id));
  }

  // ── Per-member permissions ─────────────────────────────────────────────────

  function openPermEditor(member: TeamMember) {
    setPermMember(member);
  }

  // ── Crews (subteams, #123) ─────────────────────────────────────────────────

  // Assignable people = this team's roster (CrewEditor candidates).
  const crewCandidates = useMemo<PickerOption[]>(
    () => members.map(m => ({
      id: m.user_id,
      label: m.user_name ?? m.user_id,
      sublabel: m.user_role ? (ROLE_DISPLAY_NAMES[m.user_role as UserRole] ?? m.user_role) : undefined,
    })),
    [members],
  );

  function openCrewCreate() {
    setEditingCrew(null);
    setShowCrewEditor(true);
  }

  function openCrewEdit(crew: Crew) {
    setEditingCrew(crew);
    setShowCrewEditor(true);
  }

  // CrewEditor/EntityEditSheet contract: throw on failure so the sheet stays
  // open. Create + every membership assignment commit as ONE transaction
  // (runInTransaction is reentrant, so the repo-layer calls join it). repos/
  // teams.ts's subteam functions don't self-log (see header comment) — every
  // appendLog below is this screen's own responsibility.
  function handleSaveCrew(draft: CrewDraft) {
    if (!team || isWriteBlocked()) throw new Error('write blocked');
    const actorId = realUser?.id ?? null;
    try {
      runInTransaction(() => {
        if (editingCrew) {
          if (draft.name !== editingCrew.name) {
            const { oldName } = renameSubteam(editingCrew.id, draft.name);
            appendLog({
              user_id: actorId, team_id: team.id, action: 'subteam_updated',
              entity_type: 'team', entity_id: team.id,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: `${oldName} → ${draft.name}`,
              metadata: JSON.stringify({ subteam_id: editingCrew.id, renamed: true }),
              device_id: null,
            });
          }
          // Diff memberships: clear people who left, (re)assign only changes —
          // unchanged members get no outbox/log churn.
          const beforeLead = editingCrew.lead?.id ?? null;
          const beforeHelpers = new Set(editingCrew.helpers.map(h => h.id));
          const after = new Set([draft.leadId, ...draft.helperIds]);
          for (const uid of [...(beforeLead ? [beforeLead] : []), ...beforeHelpers]) {
            if (!after.has(uid)) {
              const cleared = clearSubteamMembership(team.id, uid);
              if (cleared) {
                appendLog({
                  user_id: actorId, team_id: team.id, action: 'subteam_updated',
                  entity_type: 'team', entity_id: team.id,
                  from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
                  note: null,
                  metadata: JSON.stringify({ member_user_id: uid, subteam_cleared: true }),
                  device_id: null,
                });
              }
            }
          }
          if (beforeLead !== draft.leadId) {
            const { name } = setSubteamMembership(editingCrew.id, draft.leadId, 'lead');
            appendLog({
              user_id: actorId, team_id: team.id, action: 'subteam_updated',
              entity_type: 'team', entity_id: team.id,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: name,
              metadata: JSON.stringify({ subteam_id: editingCrew.id, member_user_id: draft.leadId, subteam_role: 'lead' }),
              device_id: null,
            });
          }
          for (const uid of draft.helperIds) {
            if (!beforeHelpers.has(uid)) {
              const { name } = setSubteamMembership(editingCrew.id, uid, 'helper');
              appendLog({
                user_id: actorId, team_id: team.id, action: 'subteam_updated',
                entity_type: 'team', entity_id: team.id,
                from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
                note: name,
                metadata: JSON.stringify({ subteam_id: editingCrew.id, member_user_id: uid, subteam_role: 'helper' }),
                device_id: null,
              });
            }
          }
        } else {
          const subteamId = createSubteam(team.id, draft.name);
          appendLog({
            user_id: actorId, team_id: team.id, action: 'subteam_created',
            entity_type: 'team', entity_id: team.id,
            from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
            note: draft.name,
            metadata: JSON.stringify({ subteam_id: subteamId }),
            device_id: null,
          });
          setSubteamMembership(subteamId, draft.leadId, 'lead');
          for (const uid of draft.helperIds) {
            setSubteamMembership(subteamId, uid, 'helper');
          }
        }
      });
    } catch (e) {
      Alert.alert('Could not save crew', 'The crew was not saved. Please try again.');
      throw e;
    }
    // Success side-effects only after the write committed; the sheet closes itself.
    setCrews(getSubteamsForTeam(team.id));
    setMembers(getTeamMembers(team.id));
  }

  async function handleDeleteCrew(crew: Crew) {
    if (!team) return;
    if (isWriteBlocked()) return;
    const ok = await confirmSheet({
      title: 'Delete Crew',
      message: `Delete ${crew.name}? Its members stay on the team.`,
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      runInTransaction(() => {
        const { name } = deleteSubteam(crew.id);
        appendLog({
          user_id: realUser?.id ?? null, team_id: team.id, action: 'subteam_updated',
          entity_type: 'team', entity_id: team.id,
          from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
          note: `${name} deleted`,
          metadata: JSON.stringify({ subteam_id: crew.id, deleted: true }),
          device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not delete crew', `${crew.name} was not deleted. Please try again.`);
      return;
    }
    setCrews(getSubteamsForTeam(team.id));
    setMembers(getTeamMembers(team.id));
  }

  // ── Permission gate ────────────────────────────────────────────────────────
  // Checked before "not found" so a denied role never learns whether the id
  // even resolves to a real team.
  if (!canView) {
    return (
      <>
        <Stack.Screen options={{ title: 'Team', headerShown: true }} />
        <PermissionGate permission="view_teams" mode="screen" />
      </>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────

  if (!team) {
    return (
      <>
        <Stack.Screen options={{ title: 'Team', headerShown: true }} />
        <View style={s.center}>
          <Text style={s.muted}>Team not found.</Text>
        </View>
      </>
    );
  }

  // ── Deep-link guard ──────────────────────────────────────────────────────────
  // Non-members with no org authority never see the roster/crews — covers a
  // stale device still holding a foreign team before reconcileTeams runs, and
  // any web client. The server scopes pulls; this is the UI backstop.
  if (!isMember && !isOrgAuthority) {
    return (
      <>
        <Stack.Screen options={{ title: team.name, headerShown: true }} />
        <View style={s.center}>
          <EmptyState
            icon="🔒"
            title="You're not a member of this team"
            subtitle="Ask a team manager or an admin to add you."
          />
        </View>
      </>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ title: team.name, headerShown: true }} />
      <ScrollView contentContainerStyle={s.content}>

        {/* Header card */}
        <Card variant="detail">
          <Text style={s.teamName}>{team.name}</Text>
          <KeyValueRow
            label="Type"
            value={(() => { const icon = getTypeIcon('team', team.type); return icon ? `${icon} ${team.type}` : team.type; })()}
          />
          {managers.length > 0 && (
            <KeyValueRow
              label={`Manager${managers.length === 1 ? '' : 's'}`}
              badge={
                <View style={s.mgrChips}>
                  {managers.map(mgr => (
                    <View key={mgr.user_id} style={s.mgrChip}>
                      <Text style={s.mgrChipText}>{mgr.user_name ?? mgr.user_id}</Text>
                    </View>
                  ))}
                </View>
              }
            />
          )}
          {canManageRoster && (
            <TouchableOpacity
              style={[s.editBtn, managerRestricted && s.mgrToggleDisabled]}
              onPress={openEdit}
              disabled={managerRestricted}
            >
              <Text style={s.editBtnText}>Edit Team</Text>
            </TouchableOpacity>
          )}
          {managerRestricted && (
            <Text style={s.restrictNote}>
              You're a team manager. Only an organization admin can appoint managers,
              rename or delete the team, or remove you from it.
            </Text>
          )}
        </Card>

        {/* Roster */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>Members ({members.length})</Text>
          {canManageRoster && (
            <TouchableOpacity onPress={() => setShowAddMember(true)}>
              <Text style={s.addLink}>+ Add</Text>
            </TouchableOpacity>
          )}
        </View>

        <Card variant="detail">
          {members.length === 0 ? (
            <Text style={s.muted}>
              No members yet{canManageRoster ? '. Tap "+ Add" to add someone.' : '.'}
            </Text>
          ) : (
            members.map((m, i) => {
              // Client-side hierarchy gate (server enforces authoritatively): a
              // manager can only toggle manager status / edit team permission
              // overrides for members at or below their own effective tier. Fail
              // closed if the session role is missing. (Remove stays available —
              // it's a membership action, not a role/permission change.)
              const canActMember = canActOnTarget((user?.role ?? '') as UserRole, (m.user_role ?? '') as UserRole);
              // A manager without org authority may not remove themselves (courtesy
              // gray-out; the server is the enforcement of record).
              const blockSelfRemove = managerRestricted && m.user_id === user?.id;
              return (
              <View
                key={m.user_id}
                style={[s.memberRow, i < members.length - 1 && s.divider]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[s.memberName, { color: roleColor(m.user_role ?? '', roleColors) }]}>{m.user_name ?? m.user_id}</Text>
                  {!!m.user_role && (
                    <Text style={s.memberRole}>
                      {ROLE_DISPLAY_NAMES[m.user_role as UserRole] ?? m.user_role}
                    </Text>
                  )}
                  {canManageRoster && !canActMember && (
                    <Text style={s.lockNote}>
                      🔒 At or above your access level — you can't change their role or permissions.
                    </Text>
                  )}
                </View>
                {/* TODO(wave-chat): message-member button cut — chat isn't ported yet. */}
                {canManageRoster ? (
                  <TouchableOpacity
                    onPress={() => handleToggleManager(m)}
                    disabled={locked || !canActMember || managerRestricted}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[
                      s.mgrToggle,
                      m.is_manager === 1 && s.mgrToggleActive,
                      (locked || !canActMember || managerRestricted) && s.mgrToggleDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        s.mgrToggleText,
                        m.is_manager === 1 && s.mgrToggleTextActive,
                      ]}
                    >
                      {m.is_manager === 1 ? '★ Manager' : 'Make manager'}
                    </Text>
                  </TouchableOpacity>
                ) : m.is_manager === 1 ? (
                  <View style={s.mgrBadge}>
                    <Text style={s.mgrBadgeText}>Manager</Text>
                  </View>
                ) : null}
                {canManageRoster && (
                  <TouchableOpacity
                    onPress={() => openPermEditor(m)}
                    disabled={locked || !canActMember}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[s.permsBtn, (locked || !canActMember) && s.mgrToggleDisabled]}
                  >
                    <Text style={s.permsText}>Perms</Text>
                  </TouchableOpacity>
                )}
                {canManageRoster && (
                  <TouchableOpacity
                    onPress={() => handleRemoveMember(m)}
                    disabled={blockSelfRemove}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[s.removeBtn, blockSelfRemove && s.mgrToggleDisabled]}
                  >
                    <Text style={s.removeText}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
              );
            })
          )}
        </Card>

        {/* Crews (subteams, #123) — lead + helpers inside this team. Create/edit/
            delete follow the roster's manage gate (canManageRoster = org authority
            OR this team's managers); the server's manage_teams + per-team authority
            guard on /sync/push is the enforcement of record. */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>Crews ({crews.length})</Text>
          {canManageRoster && (
            <TouchableOpacity onPress={openCrewCreate} disabled={locked}>
              <Text style={[s.addLink, locked && s.mgrToggleDisabled]}>+ Add</Text>
            </TouchableOpacity>
          )}
        </View>

        {crews.length === 0 ? (
          <Card variant="detail">
            <Text style={s.muted}>
              No crews yet{canManageRoster ? '. Tap "+ Add" to pair a lead with helpers.' : '.'}
            </Text>
          </Card>
        ) : (
          crews.map(crew => (
            <CrewCard
              key={crew.id}
              crew={crew}
              right={canManageRoster ? (
                <View style={s.crewActions}>
                  <TouchableOpacity
                    onPress={() => openCrewEdit(crew)}
                    disabled={locked}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[s.permsBtn, locked && s.mgrToggleDisabled]}
                  >
                    <Text style={s.permsText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleDeleteCrew(crew)}
                    disabled={locked}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[s.crewDeleteBtn, locked && s.mgrToggleDisabled]}
                  >
                    <Text style={s.removeText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              ) : undefined}
            />
          ))
        )}

      </ScrollView>

      {/* Edit team modal — onClose only hides; inputs are preserved on outside-tap dismiss */}
      <EntityEditSheet
        visible={showEdit}
        onClose={() => setShowEdit(false)}
        title="Edit Team"
        onSave={handleSaveEdit}
        saveLabel="Save Changes"
        disabled={locked}
      >
        <View style={{ gap: 12 }}>
          <AppInput
            placeholder="Team name *"
            value={editName}
            onChangeText={setEditName}
            autoFocus
          />

          <TaxonomyChips
            category="team"
            label="Type"
            withFallback
            valueLabel={editType}
            onChange={v => setEditType(v.label ?? '')}
          />

          {locked && <MaintenanceBanner />}
        </View>
      </EntityEditSheet>

      {/* Add member modal — onClose only hides; selection preserved on outside-tap dismiss */}
      <ModalSheet visible={showAddMember} onClose={() => setShowAddMember(false)}>
          <Text style={s.modalTitle}>Add Team Member</Text>
          {/* flexShrink:1 lets this ScrollView shrink within ModalSheet's maxHeight cap so it actually scrolls (RN defaults flexShrink:0). */}
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            {nonMemberOptions.length === 0 ? (
              <Text style={s.muted}>All active users are already on this team.</Text>
            ) : (
              <SearchablePicker
                placeholder="Search people…"
                options={nonMemberOptions}
                value={newMemberOption}
                onSelect={(opt) => {
                  setNewMemberOption(prev => (prev?.id === opt.id ? null : opt));
                }}
                onCreate={() => setShowUserCreate(true)}
                autoFocus
              />
            )}

            <PrimaryButton
              label="Add to Team"
              onPress={handleAddMember}
              disabled={!newMemberOption || locked}
              style={{ marginTop: 8 }}
            />
            {locked && <MaintenanceBanner />}
            <TouchableOpacity
              style={s.cancelRow}
              onPress={() => setShowAddMember(false)}
            >
              <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
      </ModalSheet>

      {/* Crew create/edit — validation + draft shape live in CrewEditor; this
          screen's handleSaveCrew owns persistence (one transaction). */}
      <CrewEditor
        visible={showCrewEditor}
        onClose={() => setShowCrewEditor(false)}
        crew={editingCrew}
        candidates={crewCandidates}
        onSave={handleSaveCrew}
        disabled={locked}
      />

      {/* Inline create-user from the member picker — on create, select the new
          user just as picking an existing one would (then tap "Add to Team"). */}
      <QuickCreateSheet
        visible={showUserCreate}
        kind="user"
        onClose={() => setShowUserCreate(false)}
        onCreated={(entity) => {
          setNewMemberOption({ id: entity.id, label: entity.label });
          setShowUserCreate(false);
        }}
      />

      {/* Per-member permissions (team overrides) — the Perms button's row
          gate stays above; the sheet re-checks the canActOnTarget hierarchy
          internally as a safety net. */}
      <MemberPermissionsSheet
        visible={!!permMember}
        onClose={() => setPermMember(null)}
        teamId={team.id}
        teamName={team.name}
        member={permMember}
        onChanged={() => setMembers(getTeamMembers(team.id))}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: t.colors.textMuted },

  teamName: { fontSize: 22, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },

  divider: { borderTopWidth: 1, borderTopColor: t.colors.surfaceAlt },

  mgrChips: {
    flex: 1, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end',
    gap: 6, marginLeft: 12,
  },
  mgrChip: {
    backgroundColor: t.colors.primaryBg, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  mgrChipText: { color: t.colors.primaryText, fontSize: 13, fontWeight: '700' },

  editBtn: {
    marginTop: 12, backgroundColor: t.colors.primaryBg, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  editBtnText: { color: t.colors.primaryText, fontWeight: '700', fontSize: 14 },

  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  addLink: { color: t.colors.primary, fontSize: 14, fontWeight: '700' },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
  },
  memberName: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600' },
  memberRole: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  lockNote: { fontSize: 12, color: t.colors.textMuted, lineHeight: 16, marginTop: 4, maxWidth: '90%' },
  restrictNote: { fontSize: 12, color: t.colors.textMuted, lineHeight: 16, marginTop: 10 },
  removeBtn: { marginLeft: 12 },
  removeText: { color: t.colors.danger, fontSize: 13, fontWeight: '600' },
  permsBtn: {
    marginLeft: 10, borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  crewActions: { flexDirection: 'row', alignItems: 'center' },
  crewDeleteBtn: {
    marginLeft: 10, borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  permsText: { color: t.colors.textSecondary, fontSize: 12, fontWeight: '700' },

  mgrToggle: {
    borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  mgrToggleActive: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primaryBg },
  mgrToggleDisabled: { opacity: 0.5 },
  mgrToggleText: { color: t.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  mgrToggleTextActive: { color: t.colors.primaryText },

  mgrBadge: {
    backgroundColor: t.colors.primaryBg, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  mgrBadgeText: { color: t.colors.primaryText, fontSize: 12, fontWeight: '700' },

  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  cancelRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  linkText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
});
