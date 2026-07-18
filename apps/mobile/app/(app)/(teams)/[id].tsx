import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getTeamById, getTeamMembers, upsertTeam, addTeamMember, removeTeamMember,
  setMemberManagerOnline, setMemberPermissionOverridesOnline,
  TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS, Team, TeamMember,
} from '../../../src/db/queries/teams';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { getAllActiveUsers, roleColor, getRoleColorMap, getRolePermissionOverrides } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES, ROLE_DEFAULTS, ROLE_TIER, UserRole, Permission, canActOnTarget } from '../../../src/constants/roles';
import { parsePermissionOverrides } from '../../../src/auth/permissions';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getTypeIcon } from '../../../src/db/queries/taxonomy';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { TaxonomyChips } from '../../../src/components/pickers';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { KeyValueRow } from '../../../src/components/ui/KeyValueRow';
import { confirmSheet } from '../../../src/components/ui/ConfirmSheet';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { EntityEditSheet } from '../../../src/components/ui/EntityEditSheet';
import { QuickCreateSheet } from '../../../src/components/quickadd/QuickCreateSheet';
import { createDmConversation } from '../../../src/db/queries/chat';
import { syncNow } from '../../../src/sync/engine';
import { track } from '../../../src/telemetry';
import { validateName } from '../../../src/lib/validation';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'team_detail', props: { field, rule } });
}

export default function TeamDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const router = useRouter();

  const [team, setTeam] = useState<Team | null>(() => getTeamById(id));
  const [members, setMembers] = useState<TeamMember[]>(() => getTeamMembers(id));

  // Re-read team + roster on focus or sync pull so a stale foreign team (still held
  // before teamPurge.reconcileTeams runs) or a server-side manager demotion
  // self-corrects once the next pull applies — the disables below are courtesy,
  // not enforcement.
  const refreshKey = useFocusOrDataRefresh();
  useEffect(() => {
    setTeam(getTeamById(id));
    setMembers(getTeamMembers(id));
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
  const [userCreateInitial, setUserCreateInitial] = useState('');

  // Per-member permission override editor
  const [permMember, setPermMember] = useState<TeamMember | null>(null);
  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});
  const [savingPerms, setSavingPerms] = useState(false);

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const roleColors = useMemo(() => getRoleColorMap(), []);
  // Role-level permission deviations, used as the "base" a team override is
  // relative to (mirrors the resolution order in auth/permissions.ts: role
  // default → role override → [team override, edited here] → user override).
  const roleOverrides = useMemo(() => getRolePermissionOverrides(), []);
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );

  // Managers are members flagged is_manager (multi-manager model). Read is_manager,
  // NOT the deprecated teams.manager_id column.
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
    const now = new Date().toISOString();
    // manager_id is deprecated/legacy (managers are now flagged is_manager on
    // team_members). Preserve whatever value exists — don't read/write it from UI.
    const updated: Team = {
      ...team,
      name: trimmed,
      type: editType,
      updated_at: now,
    };
    try {
      runInTransaction(() => {
        const typeId = upsertTeam(updated);
        appendOutbox('UPDATE', 'teams', {
          id: team.id,
          name: trimmed,
          type: editType,
          type_id: typeId,
          updated_at: now,
        });
        appendLog({
          user_id: user?.id ?? null,
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
    setTeam(updated);
  }

  // ── Add member ─────────────────────────────────────────────────────────────

  function handleAddMember() {
    if (!newMemberOption || !team) return;
    if (isWriteBlocked()) return;
    let result: ReturnType<typeof addTeamMember>;
    try {
      result = runInTransaction(() => {
        const r = addTeamMember(team.id, newMemberOption.id, {}, user?.id ?? null);
        if (r === null) {
          // INSERT OR IGNORE skipped — composite key already exists; no outbox/log.
          return null;
        }
        const { joined_at } = r;
        appendOutbox('INSERT', 'team_members', {
          team_id: team.id,
          user_id: newMemberOption.id,
          team_permission_overrides: '{}',
          added_by: user?.id ?? null,
          joined_at,
        });
        appendLog({
          user_id: user?.id ?? null,
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
        // Composite-key DELETE: server matches by {team_id, user_id}
        appendOutbox('DELETE', 'team_members', {
          team_id: team.id,
          user_id: member.user_id,
        });
        appendLog({
          user_id: user?.id ?? null,
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
          user_id: user?.id ?? null,
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

  // ── Message a member (find-or-create DM → open the thread) ─────────────────

  function handleMessageMember(memberUserId: string) {
    if (!user) return;
    let convId: string;
    try {
      // createDmConversation reuses an existing 1:1 before creating (queries/chat.ts).
      convId = createDmConversation(user.id, memberUserId);
    } catch {
      Alert.alert('Could not start chat', 'Please try again.');
      return;
    }
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({ pathname: '/(app)/(chat)/[id]', params: { id: convId } });
  }

  // ── Per-member permission overrides ─────────────────────────────────────────

  // Effective value BEFORE any team override — role default merged with the
  // role-level deviation (same as roles.tsx's effectivePerm, minus the team layer
  // we're editing here). Used both as the Switch's "off" baseline and to decide
  // whether a toggle should store an override key or clear it (clean reset).
  function baseTeamPermValue(role: string | null | undefined, perm: Permission): boolean {
    const r = (role ?? '') as UserRole;
    const def = ROLE_DEFAULTS[r]?.[perm] ?? false;
    const ov = roleOverrides[r];
    return ov && perm in ov ? ov[perm] : def;
  }

  function openPermEditor(member: TeamMember) {
    setPermMember(member);
    setPermDraft(parsePermissionOverrides(member.team_permission_overrides));
  }

  function togglePermDraft(perm: Permission) {
    if (!permMember) return;
    const base = baseTeamPermValue(permMember.user_role, perm);
    const cur = perm in permDraft ? permDraft[perm] : base;
    const next = !cur;
    setPermDraft(prev => {
      const copy = { ...prev };
      if (next === base) delete copy[perm]; else copy[perm] = next;
      return copy;
    });
  }

  async function handleSavePermDraft() {
    if (!permMember || !team) return;
    if (isWriteBlocked()) return;
    setSavingPerms(true);
    try {
      await setMemberPermissionOverridesOnline(team.id, permMember.user_id, permDraft);
    } catch (e) {
      setSavingPerms(false);
      Alert.alert('Could not update permissions', (e as Error).message);
      return;
    }
    // Activity log is best-effort (and never blocks the change already committed above).
    try {
      appendLog({
        user_id: user?.id ?? null,
        team_id: team.id,
        action: 'user_permission_changed',
        entity_type: 'user',
        entity_id: permMember.user_id,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        job_id: null,
        note: `${permMember.user_name ?? permMember.user_id} · ${team.name} team permissions updated`,
        metadata: JSON.stringify({ team_id: team.id, overrides: permDraft }),
        device_id: null,
      });
    } catch { /* logging is non-critical */ }
    setSavingPerms(false);
    setMembers(getTeamMembers(team.id));
    setPermMember(null);
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
  // Non-members with no org authority never see the roster/activity/stock — covers a
  // stale device still holding a foreign team before reconcileTeams runs, and any web
  // client. The server scopes pulls (sync.ts teamScopeSql); this is the UI backstop.
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
                {m.user_id !== user?.id && (
                  <TouchableOpacity
                    onPress={() => handleMessageMember(m.user_id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={s.msgBtn}
                    accessibilityLabel={`Message ${m.user_name ?? 'member'}`}
                  >
                    <Text style={s.msgText}>💬</Text>
                  </TouchableOpacity>
                )}
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
                onCreate={(text) => {
                  setUserCreateInitial(text);
                  setShowUserCreate(true);
                }}
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

      {/* Inline create-user from the member picker — on create, select the new
          user just as picking an existing one would (then tap "Add to Team"). */}
      <QuickCreateSheet
        visible={showUserCreate}
        kind="user"
        initialName={userCreateInitial}
        onClose={() => setShowUserCreate(false)}
        onCreated={(entity) => {
          setNewMemberOption({ id: entity.id, label: entity.label });
          setShowUserCreate(false);
        }}
      />

      {/* Per-member team permission override editor — onClose only hides;
          unsaved toggles are discarded on outside-tap dismiss (draft-only until Save). */}
      <ModalSheet visible={!!permMember} onClose={() => setPermMember(null)}>
        <Text style={s.modalTitle}>
          {permMember ? `${permMember.user_name ?? permMember.user_id} · Team Permissions` : 'Team Permissions'}
        </Text>
        {/* flexShrink:1 lets this ScrollView shrink within ModalSheet's maxHeight cap so it actually scrolls (RN defaults flexShrink:0). */}
        <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
          <Text style={s.permsIntro}>
            Overrides apply only within {team.name}. Toggling a permission back to its
            default removes the override.
          </Text>
          {(() => {
            // Mirror the row-level hierarchy gate inside the editor as a safety net
            // (the Perms button is already disabled for out-of-tier members).
            const permMemberLocked = !canActOnTarget((user?.role ?? '') as UserRole, (permMember?.user_role ?? '') as UserRole);
            return permMember && TEAM_OVERRIDABLE_PERMISSIONS.map(perm => {
              const base = baseTeamPermValue(permMember.user_role, perm);
              const value = perm in permDraft ? permDraft[perm] : base;
              const modified = perm in permDraft;
              return (
                <View key={perm} style={s.permRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.permLabel}>{TEAM_PERMISSION_LABELS[perm]}</Text>
                    {modified && <Text style={s.modifiedBadge}>overridden</Text>}
                  </View>
                  <Switch
                    value={value}
                    disabled={locked || savingPerms || permMemberLocked}
                    onValueChange={() => togglePermDraft(perm)}
                    trackColor={{ true: t.colors.primary, false: t.colors.border }}
                  />
                </View>
              );
            });
          })()}

          <PrimaryButton
            label={savingPerms ? 'Saving…' : 'Save Permissions'}
            onPress={handleSavePermDraft}
            disabled={locked || savingPerms}
            style={{ marginTop: 8 }}
          />
          {locked && <MaintenanceBanner />}
          <TouchableOpacity
            style={s.cancelRow}
            onPress={() => setPermMember(null)}
          >
            <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: t.colors.textMuted },

  teamName: { fontSize: 22, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: 14, color: t.colors.textSecondary },
  attrVal: {
    fontSize: 14, color: t.colors.textPrimary, fontWeight: '600',
    maxWidth: '60%', textAlign: 'right', textTransform: 'capitalize',
  },
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
  permsText: { color: t.colors.textSecondary, fontSize: 12, fontWeight: '700' },
  msgBtn: {
    marginLeft: 10, borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  msgText: { color: t.colors.primary, fontSize: 12, fontWeight: '700' },

  permsIntro: { fontSize: 13, color: t.colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permLabel: { fontSize: 14, color: t.colors.textPrimary },
  modifiedBadge: { fontSize: 11, color: t.colors.warning, fontWeight: '600', marginTop: 2 },

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
