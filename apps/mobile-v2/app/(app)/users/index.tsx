// Ported from apps/mobile/app/(app)/(admin)/users.tsx.
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/users' → '../../../src/repos/users' (users) +
//     '../../../src/repos/roleSettings' (role_settings)
//   '../../../src/db/tx' (runInTransaction) → '@invenpro/core'
//   '../../../src/sync/outbox' (appendOutbox) → dropped; every write here
//     self-mirrors via repos/users.ts (createRepository('users')).
//   '../../../src/hooks/useReactiveRows', useDataVersion → '@invenpro/core'
//   '../../../src/lib/themedAlert' (Alert), ui/* components, confirmSheet,
//     useMultiSelect, BulkActionBar, useTheme, useThemedStyles → '@invenpro/ui'
//
// Cut for this wave (coordinator's cut-list / unported domains — see
// docs/REBUILD-NOTES.md Wave B section):
//   - Dashboard preset assignment (dashboard preset engine is cut entirely).
// Personal locker toggle restored in Station B3 (src/access/personalLocker.ts).
// Message button / DM restored in Station D1 (src/repos/chat.ts).
//
// Bulk "Add to team" (was TODO(wave-B-teams)) is now wired to
// src/repos/teams.ts's addTeamMember (ported in Station B2).
import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, Switch,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useTheme, useThemedStyles, confirmSheet, useMultiSelect,
  ModalSheet, PrimaryButton, AppInput, FieldLabel, SearchHeader, StatusBadge,
  SelectField, BulkActionBar, type BulkAction,
} from '@invenpro/ui';
import { useReactiveRows, useTableVersion, runInTransaction, syncNow } from '@invenpro/core';
import { createDmConversation } from '../../../src/repos/chat';
import {
  getAllUsers, setUserActive, setUserRole, changeRoleOnline, applyOnlineRoleChange,
  saveUserFields, createUserOnline, resetUserPinOnline, resetEnrollmentCodeOnline,
  setUserPermissionOverrides, type User,
} from '../../../src/repos/users';
import { getRoleSettings, getRolePermissionOverrides, getRoleColorMap, roleColor } from '../../../src/repos/roleSettings';
import { getAllTeams, addTeamMember } from '../../../src/repos/teams';
import {
  ROLE_DISPLAY_NAMES, UserRole, ROLE_TIER, PIN_LENGTH_BY_TIER, Permission,
  ROLE_DEFAULTS, canActOnTarget, canAssignRole,
} from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { enablePersonalLocker, disablePersonalLocker, getPersonalLocker } from '../../../src/access/personalLocker';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

const ALL_PERMISSIONS: Permission[] = [
  'checkout_inventory', 'checkin_inventory', 'add_inventory',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'manage_other_team_inventory',
  'create_jobs', 'close_jobs',
  'manage_teams', 'checkout_for_team', 'manage_users',
  'view_all_logs', 'view_own_logs', 'manage_locations',
  'upload_media', 'set_pins', 'manage_roles_permissions',
  'view_financial_data', 'system_settings',
];

function parseOverrides(user: User): Record<string, boolean> {
  try { return JSON.parse(user.permission_overrides ?? '{}'); }
  catch { return {}; }
}

type Status = 'active' | 'inactive' | 'expired';
function userStatus(u: User): Status {
  if (!u.active) return 'inactive';
  if (u.expires_at && new Date(u.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

const statusMeta = (t: Theme): Record<Status, { label: string; tone: 'success' | 'warning' | 'danger' }> => ({
  active:   { label: 'Active',   tone: 'success' },
  inactive: { label: 'Inactive', tone: 'danger' },
  expired:  { label: 'Expired',  tone: 'warning' },
});

function isoFromNowDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function UsersScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const STATUS_META = statusMeta(t);
  const router = useRouter();
  const { user: sessionUser, realUser } = useSession();
  const canManageUsers = usePermission('manage_users');
  const canManageLocations = usePermission('manage_locations');
  const { locked } = useMaintenanceMode();
  const lockerVersion = useTableVersion(['locations']);
  const sel = useMultiSelect<User>();

  // Re-read on sync pull so a user added/edited on another device shows while
  // this screen is open, but stay referentially stable across no-op bumps so
  // the list never re-renders mid-scroll. `refresh` re-reads after a local write.
  const [users, refresh] = useReactiveRows<User>(getAllUsers, ['users']);
  // Bulk "Add to team" needs the team roster; kept reactive so a team created
  // elsewhere while this screen is open shows up in the picker.
  const [teams] = useReactiveRows(getAllTeams, ['teams']);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkRolePicker, setShowBulkRolePicker] = useState(false);
  const [showBulkTeamPicker, setShowBulkTeamPicker] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('mitigation_technician');
  const [creating, setCreating] = useState(false);

  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('mitigation_technician');
  const [editExpiry, setEditExpiry] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // role_settings can change via a sync pull without any users-row change —
  // key these on the table they read.
  const roleSettingsVersion = useTableVersion(['role_settings']);
  const roleMinPins = useMemo(() => getRoleSettings(), [roleSettingsVersion]);
  const roleOverrides = useMemo(() => getRolePermissionOverrides(), [roleSettingsVersion]);
  const roleColors = useMemo(() => getRoleColorMap(), [roleSettingsVersion]);

  // Personal locker (#146) — provisioning is a locations write, gated the same
  // way as MemberPermissionsSheet's identical toggle. Neither
  // enablePersonalLocker/disablePersonalLocker self-logs (matches the old app).
  const editUserLocker = useMemo(
    () => (editUser ? getPersonalLocker(editUser.id) : null),
    [editUser?.id, lockerVersion],
  );

  function toggleEditUserLocker() {
    if (!editUser || isWriteBlocked()) return;
    if (editUserLocker) {
      const res = disablePersonalLocker(editUser.id);
      if (!res.ok) { Alert.alert('Could not turn off locker', res.reason); return; }
    } else {
      const res = enablePersonalLocker(editUser.id, editUser.name, editUser.role, realUser?.id ?? null);
      if (!res.ok) { Alert.alert('Could not create locker', res.reason); return; }
    }
  }

  // Find-or-create a DM with this user and open the thread (mirrors the team
  // roster's Message action; createDmConversation reuses an existing 1:1).
  function messageUser(u: User) {
    if (!sessionUser) return;
    let convId: string;
    try {
      convId = createDmConversation(sessionUser.id, u.id);
    } catch {
      Alert.alert('Could not start chat', 'Please try again.');
      return;
    }
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({ pathname: '/(app)/chat/[id]', params: { id: convId } });
  }

  function openEdit(u: User) {
    setEditUser(u);
    setEditName(u.name);
    setEditEmail(u.email ?? '');
    setEditRole(u.role);
    setEditExpiry(u.expires_at);
  }

  const editEmailNorm = editEmail.trim() || null;

  const editDirty = !!editUser && (
    editName.trim() !== editUser.name ||
    editEmailNorm !== (editUser.email ?? null) ||
    editRole !== editUser.role ||
    (editExpiry ?? null) !== (editUser.expires_at ?? null)
  );

  async function saveEdits() {
    if (!editUser) return;
    if (!editName.trim()) { Alert.alert('Required', 'Name cannot be empty.'); return; }

    const roleChanged = editRole !== editUser.role;
    const newPinLength = roleMinPins[editRole] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[editRole]];
    const pinLengthChanged = roleChanged && newPinLength !== editUser.pin_length_required;

    if (roleChanged) {
      const ok = await confirmSheet({
        title: `Change ${editUser.name}'s role?`,
        message: pinLengthChanged
          ? `${ROLE_DISPLAY_NAMES[editUser.role as UserRole]} → ${ROLE_DISPLAY_NAMES[editRole]}.\n\nThe new role requires a different PIN length, so their current PIN stops working and they'll get a one-time enrollment code to set a new one. This requires a connection to the server.`
          : `${ROLE_DISPLAY_NAMES[editUser.role as UserRole]} → ${ROLE_DISPLAY_NAMES[editRole]}.`,
        confirmLabel: 'Change role',
      });
      if (!ok) return;
    }

    const otherFields: Record<string, unknown> = {};
    if (editName.trim() !== editUser.name) otherFields.name = editName.trim();
    if (editEmailNorm !== (editUser.email ?? null)) otherFields.email = editEmailNorm;
    if ((editExpiry ?? null) !== (editUser.expires_at ?? null)) otherFields.expires_at = editExpiry;
    if (roleChanged && !pinLengthChanged) {
      otherFields.role = editRole;
      otherFields.pin_length_required = newPinLength;
    }

    if (Object.keys(otherFields).length === 0 && !pinLengthChanged) { setEditUser(null); return; }

    const adminId = realUser?.id ?? null;

    if (pinLengthChanged) {
      setBusy(true);
      let result: Awaited<ReturnType<typeof changeRoleOnline>>;
      try {
        result = await changeRoleOnline(editUser.id, editRole);
      } catch (err) {
        setBusy(false);
        Alert.alert('Could not change role', (err as Error).message);
        return;
      }
      // The role/PIN change already landed server-side above. Mirror it locally
      // (no outbox — already synced), then apply any other offline-capable
      // field edits in the same transaction; a failure here only affects
      // name/expiry, it does not undo the role change.
      try {
        runInTransaction(() => {
          applyOnlineRoleChange(editUser.id, editRole, result.pin_length_required);
          appendLog({
            action: 'user_role_changed', entity_type: 'user', entity_id: editUser.id, user_id: adminId,
            note: `${editUser.name}: ${editUser.role} → ${editRole}`,
            team_id: null, from_location_id: null, to_location_id: null,
            quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
          });
          if (Object.keys(otherFields).length > 0) {
            const now = saveUserFields(editUser.id, otherFields as never);
            appendLog({
              action: 'user_updated', entity_type: 'user', entity_id: editUser.id, user_id: adminId,
              note: `${editUser.name}: updated ${Object.keys(otherFields).join(', ')} (${now})`,
              team_id: null, from_location_id: null, to_location_id: null,
              quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
            });
          }
        });
      } catch (err) {
        setBusy(false);
        refresh();
        setEditUser(null);
        Alert.alert('Role changed, but could not save other changes', (err as Error).message);
        return;
      }
      setBusy(false);
      refresh();
      setEditUser(null);
      Alert.alert(
        'Role changed',
        result.enrollment_code
          ? `${editUser.name}'s PIN was reset for the new role.\n\nOne-time enrollment code: ${result.enrollment_code}\n\nShare this with them to set a new PIN at next sign-in.`
          : `${editUser.name} is now ${ROLE_DISPLAY_NAMES[editRole]}.`,
      );
      return;
    }

    // Offline-capable path (name/expiry, and/or a same-length role change):
    // local update + outbox mirror + activity log all commit together.
    try {
      runInTransaction(() => {
        saveUserFields(editUser.id, otherFields as never);
        appendLog({
          action: roleChanged ? 'user_role_changed' : 'user_updated', entity_type: 'user', entity_id: editUser.id, user_id: adminId,
          note: roleChanged
            ? `${editUser.name}: ${editUser.role} → ${editRole}`
            : `${editUser.name}: updated ${Object.keys(otherFields).join(', ')}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
        });
      });
    } catch (err) {
      Alert.alert('Could not save changes', (err as Error).message);
      return;
    }
    refresh();
    setEditUser(null);
  }

  async function toggleActive() {
    if (!editUser) return;
    const next = !editUser.active;
    const verb = next ? 'Reactivate' : 'Deactivate';
    const ok = await confirmSheet({
      title: `${verb} ${editUser.name}?`,
      message: next
        ? 'They will be able to sign in again.'
        : 'They will be signed out and hidden from the login picker. You can reactivate them later.',
      confirmLabel: verb,
      destructive: !next,
    });
    if (!ok) return;
    try {
      runInTransaction(() => {
        setUserActive(editUser.id, next);
        appendLog({
          action: 'user_updated', entity_type: 'user', entity_id: editUser.id, user_id: realUser?.id ?? null,
          note: `${editUser.name}: ${next ? 'reactivated' : 'deactivated'}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
        });
      });
    } catch (err) {
      Alert.alert(`Could not ${verb.toLowerCase()} user`, (err as Error).message);
      return;
    }
    setEditUser({ ...editUser, active: next ? 1 : 0 });
    refresh();
  }

  async function resetPin() {
    if (!editUser) return;
    const ok = await confirmSheet({
      title: `Reset ${editUser.name}'s PIN?`,
      message: 'Their current PIN stops working immediately. They will set and confirm a brand-new PIN themselves the next time they sign in.',
      confirmLabel: 'Reset PIN',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await resetUserPinOnline(editUser.id);
      // No client-side appendLog here — the server writes the authoritative
      // 'user_pin_reset' activity_log row on this same request; logging it
      // again here would double it once the row syncs back down.
      setEditUser({ ...editUser, pin_set: 0 });
      refresh();
      Alert.alert('PIN reset', `${editUser.name} will set a new PIN at next sign-in.`);
    } catch (err) {
      Alert.alert('Could not reset PIN', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAccessCode() {
    if (!editUser) return;
    const onFile = editUser.email?.trim();
    const ok = await confirmSheet({
      title: `Reset access code for ${editUser.name}?`,
      message: onFile
        ? `A new one-time code will be sent to ${onFile} so they can set their PIN.`
        : `A new one-time code will be generated for ${editUser.name}. Share it with them directly so they can set their PIN.`,
      confirmLabel: onFile ? 'Reset + email code' : 'Reset code',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { emailed, code } = await resetEnrollmentCodeOnline(editUser.id);
      Alert.alert(
        emailed ? 'Access code reset + emailed' : 'Access code reset',
        (emailed
          ? `A one-time code was emailed to ${onFile}.`
          : `No email was sent. Share this code with ${editUser.name} directly.`) +
          `\n\nOne-time code: ${code}\n\nThey enter it in the app to set their PIN.`,
      );
    } catch (err) {
      Alert.alert('Could not reset access code', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // ── Bulk multi-select actions (gated on manage_users) ──────────────────

  const roleOptions = useMemo<PickerOption[]>(
    () => ALL_ROLES.map(r => ({ id: r, label: ROLE_DISPLAY_NAMES[r], sublabel: `Tier ${ROLE_TIER[r]}` })),
    [],
  );

  const teamOptions = useMemo<PickerOption[]>(
    () => teams.map(tm => ({ id: tm.id, label: tm.name, sublabel: tm.type })),
    [teams],
  );

  // No PIN/role side effects — just a team_members join row per selected
  // user. addTeamMember() no-ops (returns null) for users already on the
  // team, so a bulk add over a mixed selection only logs the real adds.
  async function bulkAddToTeam(teamId: string) {
    setShowBulkTeamPicker(false);
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const team = teams.find(tm => tm.id === teamId);
    const adminId = realUser?.id ?? null;
    let added = 0;
    try {
      runInTransaction(() => {
        for (const id of ids) {
          const u = users.find(x => x.id === id);
          try {
            const result = addTeamMember(teamId, id, {}, adminId);
            if (!result) continue; // already a member — no-op, no log churn
            added++;
            appendLog({
              action: 'team_member_added', entity_type: 'team', entity_id: teamId, user_id: adminId,
              note: `${u?.name ?? id} added to ${team?.name ?? teamId}`,
              team_id: teamId, from_location_id: null, to_location_id: null,
              quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
            });
          } catch (err) {
            throw new Error(`${u?.name ?? id}: ${(err as Error).message}`);
          }
        }
      });
    } catch (err) {
      Alert.alert('Could not add to team', `${(err as Error).message}\n\nNo changes were made.`);
      return;
    }
    refresh();
    sel.exit();
    Alert.alert(
      added === 0 ? 'Already on team' : 'Added to team',
      added === 0
        ? `Everyone selected is already on ${team?.name ?? 'that team'}.`
        : `${added} user${added === 1 ? '' : 's'} added to ${team?.name ?? 'the team'}.`,
    );
  }

  async function bulkSetActive(active: boolean) {
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const verb = active ? 'Reactivate' : 'Deactivate';
    const ok = await confirmSheet({
      title: `${verb} ${ids.length} user${ids.length === 1 ? '' : 's'}?`,
      message: active
        ? 'They will be able to sign in again.'
        : 'They will be signed out and hidden from the login picker. You can reactivate them later.',
      confirmLabel: verb,
      destructive: !active,
    });
    if (!ok) return;
    const adminId = realUser?.id ?? null;
    try {
      runInTransaction(() => {
        for (const id of ids) {
          const u = users.find(x => x.id === id);
          try {
            setUserActive(id, active);
            appendLog({
              action: 'user_updated', entity_type: 'user', entity_id: id, user_id: adminId,
              note: `${u?.name ?? id}: ${active ? 'reactivated' : 'deactivated'}`,
              team_id: null, from_location_id: null, to_location_id: null,
              quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
            });
          } catch (err) {
            throw new Error(`${u?.name ?? id}: ${(err as Error).message}`);
          }
        }
      });
    } catch (err) {
      Alert.alert('Could not update users', `${(err as Error).message}\n\nNo changes were made.`);
      return;
    }
    refresh();
    sel.exit();
  }

  async function bulkChangeRole(role: UserRole) {
    setShowBulkRolePicker(false);
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const adminId = realUser?.id ?? null;
    const pinLen = roleMinPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]];

    const offlineIds: string[] = [];
    const onlineIds: string[] = [];
    for (const id of ids) {
      const u = users.find(x => x.id === id);
      if (u && u.pin_length_required !== pinLen) onlineIds.push(id);
      else offlineIds.push(id);
    }

    const ok0 = await confirmSheet({
      title: `Change role for ${ids.length} user${ids.length === 1 ? '' : 's'}?`,
      message: onlineIds.length > 0
        ? `They will become ${ROLE_DISPLAY_NAMES[role]}.\n\n${onlineIds.length} of them need a different PIN length — their current PINs stop working and each gets a one-time enrollment code to set a new one. This requires a connection to the server.`
        : `They will become ${ROLE_DISPLAY_NAMES[role]}.`,
      confirmLabel: 'Change role',
    });
    if (!ok0) return;

    setBusy(true);

    if (offlineIds.length > 0) {
      try {
        runInTransaction(() => {
          for (const id of offlineIds) {
            const u = users.find(x => x.id === id);
            try {
              setUserRole(id, role, pinLen);
              appendLog({
                action: 'user_role_changed', entity_type: 'user', entity_id: id, user_id: adminId,
                note: `${u?.name ?? id}: ${u?.role ?? '?'} → ${role}`,
                team_id: null, from_location_id: null, to_location_id: null,
                quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
              });
            } catch (err) {
              throw new Error(`${u?.name ?? id}: ${(err as Error).message}`);
            }
          }
        });
      } catch (err) {
        setBusy(false);
        Alert.alert('Could not change roles', `${(err as Error).message}\n\nNo changes were made.`);
        return;
      }
    }

    const codes: string[] = [];
    let onlineFail = 0;
    let lastErr = '';
    for (const id of onlineIds) {
      const u = users.find(x => x.id === id);
      try {
        const result = await changeRoleOnline(id, role);
        applyOnlineRoleChange(id, role, result.pin_length_required);
        appendLog({
          action: 'user_role_changed', entity_type: 'user', entity_id: id, user_id: adminId,
          note: `${u?.name ?? id}: ${u?.role ?? '?'} → ${role}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
        });
        if (result.enrollment_code) codes.push(`${u?.name ?? id}: ${result.enrollment_code}`);
      } catch (err) {
        onlineFail++;
        lastErr = (err as Error).message;
      }
    }

    setBusy(false);
    refresh();
    sel.exit();

    const offlineOk = offlineIds.length;
    const onlineOk = onlineIds.length - onlineFail;
    if (onlineIds.length > 0 && offlineOk === 0 && onlineOk === 0) {
      Alert.alert('Could not change roles', lastErr || "Changing to this role resets the user's PIN and requires a connection.");
      return;
    }
    const parts: string[] = [];
    if (offlineOk) parts.push(`${offlineOk} updated`);
    if (onlineOk) parts.push(`${onlineOk} PIN-reset`);
    if (onlineFail) parts.push(`${onlineFail} failed (needs a connection)`);
    Alert.alert(
      'Roles changed',
      `${parts.join(', ')}.${codes.length ? `\n\nEnrollment codes:\n${codes.join('\n')}` : ''}`,
    );
  }

  async function bulkResetPin() {
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const ok0 = await confirmSheet({
      title: `Reset PIN for ${ids.length} user${ids.length === 1 ? '' : 's'}?`,
      message: 'Their current PINs stop working immediately. Each user sets and confirms a new PIN at next sign-in. This requires a connection to the server.',
      confirmLabel: 'Reset PIN',
      destructive: true,
    });
    if (!ok0) return;
    setBusy(true);
    let ok = 0, fail = 0;
    let lastErr = '';
    for (const id of ids) {
      try {
        await resetUserPinOnline(id); // already marks pin_set=0 locally
        ok++;
      } catch (err) {
        fail++;
        lastErr = (err as Error).message;
      }
    }
    setBusy(false);
    refresh();
    sel.exit();
    if (ok === 0 && fail > 0) {
      Alert.alert('Could not reset PINs', lastErr || 'Reset failed.');
    } else {
      Alert.alert('PIN reset', `${ok} reset${fail ? `, ${fail} failed` : ''}.`);
    }
  }

  const bulkActions: BulkAction[] = [
    { key: 'deactivate', label: 'Deactivate', destructive: true, onPress: () => bulkSetActive(false) },
    { key: 'reactivate', label: 'Reactivate', onPress: () => bulkSetActive(true) },
    { key: 'role', label: 'Change role', onPress: () => setShowBulkRolePicker(true) },
    { key: 'team', label: 'Add to team', onPress: () => setShowBulkTeamPicker(true) },
    { key: 'pin', label: 'Reset PIN', destructive: true, onPress: bulkResetPin },
  ];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return users.filter(u => u.name.toLowerCase().includes(q));
  }, [search, users]);

  const dupUser = useMemo(() => {
    const n = newName.trim().toLowerCase();
    return n ? users.find(u => u.name.trim().toLowerCase() === n) ?? null : null;
  }, [newName, users]);

  function resetCreateForm() {
    setNewName(''); setNewEmail(''); setNewRole('mitigation_technician');
  }

  async function doCreate() {
    let createdId: string | null = null;
    const email = newEmail.trim();
    setCreating(true);
    try {
      createdId = await createUserOnline(newName.trim(), newRole);
      // The account is created online (PIN-less); the optional email travels
      // the normal offline-capable upsert/outbox path (mirrors name/expiry
      // edits) rather than the create POST.
      if (createdId && email) {
        saveUserFields(createdId, { email } as never);
      }
      refresh();
      setShowCreate(false);
      resetCreateForm();
    } catch (err) {
      Alert.alert('Could not create user', (err as Error).message);
    } finally {
      setCreating(false);
    }
    // Log outside the createUserOnline try/catch so a log-write failure is not
    // misreported as "could not create user" when the server already succeeded.
    if (createdId) {
      appendLog({
        action: 'user_created', entity_type: 'user', entity_id: createdId, user_id: realUser?.id ?? null,
        note: `${newName.trim()} (${newRole})`,
        team_id: null, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
      });
    }
  }

  function handleCreate() {
    if (!newName.trim()) {
      Alert.alert('Missing Info', "Enter the employee's name.");
      return;
    }
    if (dupUser) {
      Alert.alert(
        'Name already exists',
        `A user named "${dupUser.name}" (${ROLE_DISPLAY_NAMES[dupUser.role as UserRole]}) already exists. Create another anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create anyway', onPress: doCreate },
        ],
      );
      return;
    }
    doCreate();
  }

  function handleTogglePermission(
    userId: string,
    permission: Permission,
    nextVal: boolean,
    roleEffective: boolean,
  ) {
    const u = users.find(x => x.id === userId);
    if (!u) return;
    const overrides = parseOverrides(u);
    // Toggling to the role's CURRENT effective value clears the override
    // (clean reset) instead of storing a redundant key.
    if (nextVal === roleEffective) {
      delete overrides[permission];
    } else {
      overrides[permission] = nextVal;
    }
    try {
      runInTransaction(() => {
        setUserPermissionOverrides(userId, overrides);
        appendLog({
          action: 'user_permission_changed', entity_type: 'user', entity_id: userId, user_id: realUser?.id ?? null,
          note: `${permission}: ${nextVal}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
        });
      });
    } catch (err) {
      Alert.alert('Could not update permission', (err as Error).message);
      return;
    }
    refresh();
    if (editUser?.id === userId) {
      setEditUser(prev => prev ? { ...prev, permission_overrides: JSON.stringify(overrides) } : null);
    }
  }

  if (!canManageUsers) {
    return (
      <>
        <Stack.Screen options={{ title: 'Users & Permissions', headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>You don't have permission to manage users.</Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Users & Permissions', headerShown: true }} />
      <View style={s.container}>
        <View style={s.topBar}>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <SearchHeader value={search} onChange={setSearch} placeholder="Search users..." debounceMs={150} />
          </View>
          <TouchableOpacity style={s.addBtn} onPress={() => setShowCreate(true)}>
            <Text style={s.addBtnText}>+ New</Text>
          </TouchableOpacity>
        </View>

        <TooltipHint screenKey="users" />

        <FlatList
          data={filtered}
          keyExtractor={u => u.id}
          contentContainerStyle={[s.list, sel.active && s.listWithBar]}
          renderItem={({ item: u }) => {
            const st = userStatus(u);
            const checked = sel.isSelected(u.id);
            return (
              <TouchableOpacity
                style={[s.card, st !== 'active' && s.cardMuted, sel.active && checked && s.cardSelected]}
                onPress={() => { if (sel.active) sel.toggle(u.id); else openEdit(u); }}
                onLongPress={() => { if (canManageUsers) sel.enter(u.id); }}
              >
                {sel.active && (
                  <View style={[s.checkCircle, checked && s.checkCircleOn]}>
                    {checked && <Text style={s.checkMark}>✓</Text>}
                  </View>
                )}
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{u.name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[s.name, { color: roleColor(u.role, roleColors) }]}>{u.name}</Text>
                  <View style={s.cardSub}>
                    <Text style={s.role}>{ROLE_DISPLAY_NAMES[u.role as UserRole]}</Text>
                    {u.pin_set === 0 && <Text style={s.pinPending}>· PIN not set</Text>}
                  </View>
                </View>
                {st !== 'active' && (
                  <StatusBadge label={STATUS_META[st].label} tone={STATUS_META[st].tone} />
                )}
                {!sel.active && u.id !== sessionUser?.id && (
                  <TouchableOpacity
                    onPress={() => messageUser(u)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={s.msgBtn}
                    accessibilityLabel={`Message ${u.name}`}
                  >
                    <Text style={s.msgBtnText}>💬</Text>
                  </TouchableOpacity>
                )}
                <Text style={s.tier}>T{ROLE_TIER[u.role as UserRole]}</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>No users found</Text>}
        />

        {sel.active && (
          <BulkActionBar
            count={sel.count}
            actions={bulkActions}
            onSelectAll={() => sel.selectAll(filtered.map(u => u.id))}
            onCancel={sel.exit}
            disabled={locked || busy}
          />
        )}

        {/* Create modal */}
        <ModalSheet visible={showCreate} onClose={() => setShowCreate(false)} scroll>
          <Text style={s.modalTitle}>New User</Text>
          <AppInput placeholder="Full name" value={newName} onChangeText={setNewName} style={{ marginBottom: t.spacing.xs }} />
          {!!dupUser && (
            <Text style={s.dupWarn}>⚠ "{dupUser.name}" already exists ({ROLE_DISPLAY_NAMES[dupUser.role as UserRole]})</Text>
          )}
          <FieldLabel>Email (optional)</FieldLabel>
          <AppInput
            placeholder="name@company.com"
            value={newEmail}
            onChangeText={setNewEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            style={{ marginBottom: t.spacing.xs }}
          />
          <FieldLabel>Role</FieldLabel>
          <ScrollView style={{ maxHeight: 160 }} keyboardShouldPersistTaps="handled">
            {ALL_ROLES.map(r => (
              <TouchableOpacity key={r} style={[s.roleRow, newRole === r && s.roleRowActive]} onPress={() => setNewRole(r)}>
                <Text style={[s.roleText, newRole === r && s.roleTextActive]}>{ROLE_DISPLAY_NAMES[r]}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={s.infoBox}>
            <Text style={s.infoText}>
              🔐 No PIN needed here. {newName.trim() ? newName.trim().split(' ')[0] : 'The employee'} sets
              and confirms their own PIN the first time they sign in.
            </Text>
          </View>
          <PrimaryButton label="Create User" onPress={handleCreate} loading={creating} />
          <View style={s.modalActions}>
            <TouchableOpacity style={s.cancel} onPress={resetCreateForm}>
              <Text style={s.cancelText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.cancel} onPress={() => setShowCreate(false)}>
              <Text style={[s.cancelText, s.cancelStrong]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </ModalSheet>

        {/* Edit / info sheet */}
        <ModalSheet visible={!!editUser} onClose={() => setEditUser(null)}>
          <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 28 }} keyboardShouldPersistTaps="handled">
            {editUser && (() => {
              const st = userStatus(editUser);
              const isTemp = editRole === 'temporary_employee';
              // Client-side hierarchy gate (server enforces authoritatively).
              const callerRole = (sessionUser?.role ?? '') as UserRole;
              const canActOnUser = canActOnTarget(callerRole, editUser.role as UserRole);
              return (
                <>
                  <View style={s.sheetHead}>
                    <Text style={s.modalTitle}>{editUser.name}</Text>
                    <StatusBadge
                      label={STATUS_META[st].label}
                      tone={STATUS_META[st].tone}
                    />
                  </View>

                  <View style={s.infoGrid}>
                    <Text style={s.infoRow}>Tier <Text style={s.infoVal}>T{ROLE_TIER[editUser.role as UserRole]}</Text></Text>
                    <Text style={s.infoRow}>PIN <Text style={s.infoVal}>{editUser.pin_set ? 'set' : 'not set — first login'}</Text></Text>
                    <Text style={s.infoRow}>Added <Text style={s.infoVal}>{formatDate(editUser.created_at)}</Text></Text>
                    <Text style={s.infoRow}>Expires <Text style={s.infoVal}>{formatDate(editUser.expires_at)}</Text></Text>
                  </View>

                  <FieldLabel>Name</FieldLabel>
                  <AppInput value={editName} onChangeText={setEditName} placeholder="Full name" />

                  <FieldLabel>Email</FieldLabel>
                  <AppInput
                    value={editEmail}
                    onChangeText={setEditEmail}
                    placeholder="name@company.com"
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />

                  {!canActOnUser && (
                    <Text style={s.lockNote}>
                      🔒 This user is at or above your access level — you can't change their role or permissions.
                    </Text>
                  )}
                  <SelectField
                    label="Role"
                    value={editRole}
                    options={ALL_ROLES.filter(r => canAssignRole(callerRole, r) || r === editRole)
                      .map(r => ({ id: r, label: ROLE_DISPLAY_NAMES[r], sublabel: `Tier ${ROLE_TIER[r]}` }))}
                    onSelect={id => setEditRole(id as UserRole)}
                    disabled={!canActOnUser}
                  />

                  {isTemp && (
                    <>
                      <FieldLabel>Access expires</FieldLabel>
                      <Text style={s.hint}>Temporary employees lose access automatically after this date.</Text>
                      <View style={s.expiryRow}>
                        <View style={s.expiryCurrent}>
                          <Text style={s.expiryText}>{editExpiry ? formatDate(editExpiry) : 'No expiry set'}</Text>
                        </View>
                        {editExpiry && canActOnUser && (
                          <TouchableOpacity onPress={() => setEditExpiry(null)}>
                            <Text style={s.expiryClear}>Clear</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      <View style={[s.chipWrap, !canActOnUser && s.rowDisabled]}>
                        {[30, 60, 90].map(days => (
                          <TouchableOpacity
                            key={days}
                            style={s.expiryChip}
                            onPress={() => { if (canActOnUser) setEditExpiry(isoFromNowDays(days)); }}
                            disabled={!canActOnUser}
                          >
                            <Text style={s.expiryChipText}>+{days} days</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}

                  <PrimaryButton
                    label={editDirty ? 'Save Changes' : 'No Changes'}
                    onPress={saveEdits}
                    disabled={!editDirty || busy}
                    loading={busy}
                  />

                  <FieldLabel>Account actions</FieldLabel>
                  <TouchableOpacity style={[s.actionBtn, busy && s.btnDisabled]} onPress={resetPin} disabled={busy}>
                    <Text style={s.actionIcon}>🔑</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.actionTitle}>Reset PIN</Text>
                      <Text style={s.actionSub}>User sets a new PIN at next sign-in (online)</Text>
                    </View>
                  </TouchableOpacity>
                  {!editUser.pin_set && (
                    <TouchableOpacity style={[s.actionBtn, busy && s.btnDisabled]} onPress={resetAccessCode} disabled={busy}>
                      <Text style={s.actionIcon}>✉️</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={s.actionTitle}>Reset access code</Text>
                        <Text style={s.actionSub}>Issue a new one-time code; shown here and emailed if address is set (online)</Text>
                      </View>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[s.actionBtn, editUser.active ? s.actionDanger : s.actionGood, !canActOnUser && s.btnDisabled]}
                    onPress={toggleActive}
                    disabled={!canActOnUser}
                  >
                    <Text style={s.actionIcon}>{editUser.active ? '🚫' : '✅'}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.actionTitle, editUser.active ? s.dangerText : s.goodText]}>
                        {editUser.active ? 'Deactivate' : 'Reactivate'}
                      </Text>
                      <Text style={s.actionSub}>
                        {editUser.active ? 'Block sign-in, hide from picker' : 'Allow sign-in again'}
                      </Text>
                    </View>
                  </TouchableOpacity>

                  {/* Permission overrides */}
                  <FieldLabel>Permission Overrides</FieldLabel>
                  <Text style={s.hint}>Toggles here override the role default — only set what differs from the role.</Text>
                  {(() => {
                    const roleOv = roleOverrides[editUser.role] ?? {};
                    const ov = parseOverrides(editUser);
                    const roleName = ROLE_DISPLAY_NAMES[editUser.role as UserRole];
                    const rows = ALL_PERMISSIONS.map(perm => {
                      const roleEffective = perm in roleOv ? roleOv[perm] : (ROLE_DEFAULTS[editUser.role]?.[perm] ?? false);
                      const hasUserKey = perm in ov;
                      const effective = hasUserKey ? ov[perm] : roleEffective;
                      const isModified = hasUserKey && ov[perm] !== roleEffective;
                      return { perm, roleEffective, effective, isModified };
                    });
                    const diffCount = rows.filter(r => r.isModified).length;
                    return (
                      <>
                        <Text style={[s.overrideSummary, diffCount > 0 && s.overrideSummaryActive]}>
                          {diffCount === 0 ? `Matches ${roleName} default` : `${diffCount} override${diffCount === 1 ? '' : 's'} differ from ${roleName} default`}
                        </Text>
                        {rows.map(({ perm, roleEffective, effective, isModified }) => {
                          const label = perm.replace(/_/g, ' ');
                          return (
                            <View key={perm} style={s.permRow}>
                              {isModified && <View style={s.overrideDot} />}
                              <View style={{ flex: 1 }}>
                                <Text style={s.permName}>{label}</Text>
                                {isModified && <Text style={s.overrideBadge}>changed · role default {roleEffective ? 'on' : 'off'}</Text>}
                              </View>
                              <Switch
                                value={effective}
                                disabled={!canActOnUser}
                                onValueChange={() => handleTogglePermission(editUser.id, perm, !effective, roleEffective)}
                                trackColor={{ true: t.colors.primary, false: t.colors.border }}
                              />
                            </View>
                          );
                        })}
                      </>
                    );
                  })()}

                  {canManageLocations && (
                    <>
                      <FieldLabel>Personal Locker</FieldLabel>
                      <View style={s.permRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.permName}>Personal locker</Text>
                          <Text style={s.hint}>
                            {editUserLocker
                              ? `${editUserLocker.name} — turning off retires it (stock must be moved out first).`
                              : "Creates a locker owned by this user with their role's unit-access defaults."}
                          </Text>
                        </View>
                        <Switch
                          value={!!editUserLocker}
                          disabled={!canActOnUser}
                          onValueChange={toggleEditUserLocker}
                          trackColor={{ true: t.colors.primary, false: t.colors.border }}
                        />
                      </View>
                    </>
                  )}

                  <TouchableOpacity style={s.cancel} onPress={() => setEditUser(null)}>
                    <Text style={[s.cancelText, s.cancelStrong]}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </ScrollView>
        </ModalSheet>

        {/* Bulk: change role picker */}
        <ModalSheet visible={showBulkRolePicker} onClose={() => setShowBulkRolePicker(false)}>
          <Text style={s.modalTitle}>Change role for {sel.count} user{sel.count === 1 ? '' : 's'}</Text>
          <SearchablePicker
            placeholder="Search roles..."
            options={roleOptions}
            value={null}
            onSelect={opt => bulkChangeRole(opt.id as UserRole)}
          />
          <TouchableOpacity style={s.cancel} onPress={() => setShowBulkRolePicker(false)}>
            <Text style={[s.cancelText, s.cancelStrong]}>Cancel</Text>
          </TouchableOpacity>
        </ModalSheet>

        {/* Bulk: add to team picker */}
        <ModalSheet visible={showBulkTeamPicker} onClose={() => setShowBulkTeamPicker(false)}>
          <Text style={s.modalTitle}>Add {sel.count} user{sel.count === 1 ? '' : 's'} to a team</Text>
          {teamOptions.length === 0 ? (
            <Text style={s.gateSub}>No teams yet. Create one from Quick Add first.</Text>
          ) : (
            <SearchablePicker
              placeholder="Search teams..."
              options={teamOptions}
              value={null}
              onSelect={opt => bulkAddToTeam(opt.id)}
            />
          )}
          <TouchableOpacity style={s.cancel} onPress={() => setShowBulkTeamPicker(false)}>
            <Text style={[s.cancelText, s.cancelStrong]}>Cancel</Text>
          </TouchableOpacity>
        </ModalSheet>
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxxl, backgroundColor: t.colors.background },
  gateTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  gateSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.xxl },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingTop: t.spacing.md, gap: t.spacing.sm },
  addBtn: { backgroundColor: t.colors.primary, paddingHorizontal: t.spacing.lg, paddingVertical: 10, borderRadius: t.radii.lg },
  addBtnText: { color: t.colors.primaryText, fontWeight: '700' },
  list: { padding: t.spacing.lg, gap: t.spacing.sm },
  listWithBar: { paddingBottom: 140 },
  card: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg, borderWidth: 1, borderColor: t.colors.border,
    padding: t.spacing.md, gap: t.spacing.sm,
  },
  cardMuted: { opacity: 0.65 },
  cardSelected: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  checkCircle: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: t.colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkCircleOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.primaryText, fontSize: 12, fontWeight: '700' },
  avatar: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: t.colors.primaryBg,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontWeight: '700', color: t.colors.primary },
  name: { fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  cardSub: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  role: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary },
  pinPending: { fontSize: t.typography.fontSizes.sm, color: t.colors.warning },
  tier: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, fontWeight: '600' },
  chevron: { fontSize: 18, color: t.colors.textSecondary },
  msgBtn: {
    borderWidth: 1, borderColor: t.colors.border, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  msgBtnText: { fontSize: t.typography.fontSizes.body2 },
  empty: { textAlign: 'center', color: t.colors.textSecondary, marginTop: t.spacing.xxxl },
  modalTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.md },
  dupWarn: { color: t.colors.warning, fontSize: t.typography.fontSizes.sm, marginBottom: t.spacing.sm },
  roleRow: { paddingVertical: 10, paddingHorizontal: t.spacing.md, borderRadius: t.radii.md },
  roleRowActive: { backgroundColor: t.colors.primaryBg },
  roleText: { color: t.colors.textPrimary },
  roleTextActive: { color: t.colors.primary, fontWeight: '700' },
  infoBox: { backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md, padding: t.spacing.md, marginVertical: t.spacing.md },
  infoText: { fontSize: t.typography.fontSizes.sm, color: t.colors.textPrimary },
  modalActions: { flexDirection: 'row', justifyContent: 'center', gap: t.spacing.xl, marginTop: t.spacing.md },
  cancel: { paddingVertical: t.spacing.sm, alignItems: 'center' },
  cancelText: { color: t.colors.textSecondary },
  cancelStrong: { fontWeight: '700', color: t.colors.textPrimary },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.spacing.sm },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.md, marginBottom: t.spacing.sm },
  infoRow: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary },
  infoVal: { color: t.colors.textPrimary, fontWeight: '600' },
  lockNote: { fontSize: t.typography.fontSizes.sm, color: t.colors.warning, marginBottom: t.spacing.sm },
  hint: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, marginBottom: t.spacing.xs },
  expiryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  expiryCurrent: {},
  expiryText: { color: t.colors.textPrimary, fontWeight: '600' },
  expiryClear: { color: t.colors.danger },
  chipWrap: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.xs },
  rowDisabled: { opacity: 0.5 },
  expiryChip: { paddingVertical: 6, paddingHorizontal: t.spacing.md, borderRadius: t.radii.md, backgroundColor: t.colors.primaryBg },
  expiryChipText: { color: t.colors.primary, fontWeight: '600', fontSize: t.typography.fontSizes.sm },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, backgroundColor: t.colors.surfaceAlt,
    borderRadius: t.radii.md, padding: t.spacing.md, marginBottom: t.spacing.xs,
  },
  actionDanger: { backgroundColor: t.colors.dangerBg },
  actionGood: { backgroundColor: t.colors.successBg ?? t.colors.surfaceAlt },
  btnDisabled: { opacity: 0.5 },
  actionIcon: { fontSize: 20 },
  actionTitle: { fontWeight: '700', color: t.colors.textPrimary },
  actionSub: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary },
  dangerText: { color: t.colors.danger },
  goodText: { color: t.colors.success },
  overrideSummary: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, marginBottom: t.spacing.xs },
  overrideSummaryActive: { color: t.colors.primary, fontWeight: '600' },
  permRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 6 },
  overrideDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: t.colors.primary },
  permName: { color: t.colors.textPrimary, textTransform: 'capitalize' },
  overrideBadge: { fontSize: t.typography.fontSizes.xs ?? 11, color: t.colors.primary },
});
