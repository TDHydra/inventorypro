import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import {
  getAllUsers, updateUserLocal, markUserPinReset, getRoleSettings,
  getRolePermissionOverrides, setUserActive, setUserRole, changeRoleOnline, User,
  roleColor, getRoleColorMap,
} from '../../../src/db/queries/users';
import {
  ROLE_DISPLAY_NAMES, UserRole, ROLE_TIER, PIN_LENGTH_BY_TIER, Permission,
  ROLE_DEFAULTS, canActOnTarget, canAssignRole,
} from '../../../src/constants/roles';
import { getAllTeams, addTeamMember } from '../../../src/db/queries/teams';
import { getDashboardPresets } from '../../../src/db/queries/dashboards';
import { appendOutbox } from '../../../src/sync/outbox';
import { getDb } from '../../../src/db/schema';
import { runInTransaction } from '../../../src/db/tx';
import { getValidJwt } from '../../../src/auth/session';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useMultiSelect } from '../../../src/hooks/useMultiSelect';
import { BulkActionBar, BulkAction } from '../../../src/components/BulkActionBar';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { TooltipHint } from '../../../src/components/TooltipHint';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

const ALL_PERMISSIONS: Permission[] = [
  'checkout_inventory', 'checkin_inventory', 'add_inventory',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'create_jobs', 'close_jobs',
  'manage_teams', 'checkout_for_team', 'manage_users',
  'view_all_logs', 'view_own_logs', 'manage_locations',
  'upload_media', 'set_pins', 'manage_roles_permissions',
  'view_financial_data', 'system_settings',
];

// User creation is online-only: the server hashes the PIN (bcrypt) and the raw
// PIN never touches the device DB or the sync outbox. The created row (without
// pin_hash) is then mirrored locally for immediate display.
async function createUserOnline(name: string, role: UserRole): Promise<string> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to create users.');

  // No PIN sent — the employee sets and confirms their own on first sign-in.
  const res = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, role }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'You do not have permission to create users.' : `Could not create user (${res.status}).`);
  }

  const created = await res.json() as {
    id: string; name: string; role: string; pin_length_required: number; pin_set: boolean; created_at: string;
  };
  const db = getDb();
  const now = created.created_at ?? new Date().toISOString();
  // pin_set = 0 → the new employee will set their own PIN on first sign-in.
  db.executeSync(
    `INSERT OR REPLACE INTO users
       (id, name, role, pin_length_required, pin_set, permission_overrides, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [created.id, created.name, created.role, created.pin_length_required, created.pin_set ? 1 : 0, JSON.stringify({}), now, now]
  );
  return created.id;
}

function savePermissionOverrides(userId: string, overrides: Record<string, boolean>): void {
  const db = getDb();
  const now = new Date().toISOString();
  // Local row + outbox mirror must land together — one transaction so a failed
  // outbox enqueue can't leave the row updated without a sync record.
  runInTransaction(() => {
    db.executeSync(
      `UPDATE users SET permission_overrides = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(overrides), now, userId]
    );
    appendOutbox('UPDATE', 'users', { id: userId, permission_overrides: overrides, updated_at: now });
  });
}

function parseOverrides(user: User): Record<string, boolean> {
  try { return JSON.parse(user.permission_overrides ?? '{}'); }
  catch { return {}; }
}

// PIN reset is server-only: only the API can clear the bcrypt hash (it never
// lives on the device). After this the user re-sets their own PIN on next login.
async function resetUserPinOnline(userId: string): Promise<void> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to reset a PIN.');
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ reset_pin: true }),
  });
  if (!res.ok) {
    throw new Error(res.status === 403 ? 'You do not have permission to reset PINs.' : `Could not reset PIN (${res.status}).`);
  }
  markUserPinReset(userId);
}

// Reissue a one-time enrollment code for a not-yet-onboarded user and email it.
// Online-only (mirrors resetUserPinOnline/createUserOnline): the server hashes the
// new code and sends the mail; it returns the plaintext code so the admin can hand
// it off in person if email delivery is down. `email` optionally overrides the
// stored address for this send.
async function resetEnrollmentCodeOnline(
  userId: string,
  email?: string,
): Promise<{ emailed: boolean; code: string }> {
  const jwt = await getValidJwt();
  if (!jwt) throw new Error('Connect to the server to reset an access code.');
  const res = await fetch(`${API_BASE}/users/${userId}/reset-enrollment-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(email ? { email } : {}),
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error('You do not have permission to reset access codes.');
    if (res.status === 409) throw new Error('This user has already set a PIN. Use Reset PIN instead.');
    if (res.status === 400) throw new Error('No email on file. Add an email to this user first.');
    throw new Error(`Could not reset access code (${res.status}).`);
  }
  return res.json() as Promise<{ emailed: boolean; code: string }>;
}

type Status = 'active' | 'inactive' | 'expired';
function userStatus(u: User): Status {
  if (!u.active) return 'inactive';
  if (u.expires_at && new Date(u.expires_at).getTime() < Date.now()) return 'expired';
  return 'active';
}

const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  active:   { label: 'Active',   color: colors.success, bg: '#DCFCE7' },
  inactive: { label: 'Inactive', color: colors.danger,  bg: colors.dangerBg },
  expired:  { label: 'Expired',  color: colors.warning, bg: '#FEF3C7' },
};

function isoFromNowDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
function formatDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function AdminUsersScreen() {
  const { user: sessionUser } = useSession();
  const canManageUsers = usePermission('manage_users');
  const { locked } = useMaintenanceMode();
  const sel = useMultiSelect<User>();
  const [users, setUsers] = useState<User[]>(() => getAllUsers());
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showBulkRolePicker, setShowBulkRolePicker] = useState(false);
  const [showBulkTeamPicker, setShowBulkTeamPicker] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('mitigation_technician');
  const [newPin, setNewPin] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit form state (initialised when an edit sheet opens)
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('mitigation_technician');
  const [editExpiry, setEditExpiry] = useState<string | null>(null);
  const [editDashboardPresetId, setEditDashboardPresetId] = useState<string | null>(null);
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [showDashboardPicker, setShowDashboardPicker] = useState(false);
  const [busy, setBusy] = useState(false);

  const roleMinPins = useMemo(() => getRoleSettings(), [users]);
  // Per-role permission deviations (the dynamic role default). User overrides are
  // diffed against ROLE_DEFAULTS merged with these, so a user override only reads
  // as "modified" when it differs from the role's CURRENT effective value.
  const roleOverrides = useMemo(() => getRolePermissionOverrides(), [users]);
  const roleColors = useMemo(() => getRoleColorMap(), []);
  // Dashboard assignment options: null = fall back to the user's role default,
  // then every ACTIVE preset (inactive presets are hidden from assignment).
  const dashboardOptions = useMemo<{ id: string | null; label: string }[]>(
    () => [
      { id: null, label: 'Role default' },
      ...getDashboardPresets().filter(p => p.active).map(p => ({ id: p.id as string | null, label: p.name })),
    ],
    [users],
  );

  function refresh() { setUsers(getAllUsers()); }

  function openEdit(u: User) {
    setEditUser(u);
    setEditName(u.name);
    setEditEmail(u.email ?? '');
    setEditRole(u.role);
    setEditExpiry(u.expires_at);
    setEditDashboardPresetId(u.dashboard_preset_id ?? null);
    setShowRolePicker(false);
    setShowDashboardPicker(false);
  }

  // Normalize email edits: trim, and treat "" as null so a cleared field diffs
  // cleanly against a stored null.
  const editEmailNorm = editEmail.trim() || null;

  const editDirty = !!editUser && (
    editName.trim() !== editUser.name ||
    editEmailNorm !== (editUser.email ?? null) ||
    editRole !== editUser.role ||
    (editExpiry ?? null) !== (editUser.expires_at ?? null) ||
    (editDashboardPresetId ?? null) !== (editUser.dashboard_preset_id ?? null)
  );

  async function saveEdits() {
    if (!editUser) return;
    if (!editName.trim()) { Alert.alert('Required', 'Name cannot be empty.'); return; }

    const roleChanged = editRole !== editUser.role;
    const newPinLength = roleMinPins[editRole] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[editRole]];
    // A role change that also changes the required PIN length invalidates the
    // user's current PIN. Only the server can clear it and issue a fresh
    // enrollment code (the sync outbox always denies pin_hash/pin_set/
    // enrollment_code_hash writes), so THIS case must go through the REST PATCH
    // (changeRoleOnline) instead of the outbox — same as the dedicated Reset PIN
    // action. A same-length role change keeps the normal offline-capable path.
    const pinLengthChanged = roleChanged && newPinLength !== editUser.pin_length_required;

    // name/expiry (and, when same-length, the role itself) travel the existing
    // offline-capable outbox path. When pinLengthChanged, role/pin_length_required
    // are deliberately excluded here — changeRoleOnline owns those below.
    const otherFields: Record<string, unknown> = {};
    if (editName.trim() !== editUser.name) otherFields.name = editName.trim();
    if (editEmailNorm !== (editUser.email ?? null)) otherFields.email = editEmailNorm;
    if ((editExpiry ?? null) !== (editUser.expires_at ?? null)) otherFields.expires_at = editExpiry;
    // Dashboard assignment (null = role default) rides the same offline-capable
    // outbox path as name/email — dashboard_preset_id syncs on the manage_users
    // -gated users push.
    if ((editDashboardPresetId ?? null) !== (editUser.dashboard_preset_id ?? null)) {
      otherFields.dashboard_preset_id = editDashboardPresetId;
    }
    if (roleChanged && !pinLengthChanged) {
      otherFields.role = editRole;
      otherFields.pin_length_required = newPinLength;
    }

    if (Object.keys(otherFields).length === 0 && !pinLengthChanged) { setEditUser(null); return; }

    const adminId = sessionUser?.id ?? null;

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
      // The role/PIN change already landed server-side above. Mirror it locally,
      // then apply any other (offline-capable) field edits in the same
      // transaction — a failure here only affects name/expiry, it does not undo
      // the role change.
      try {
        runInTransaction(() => {
          updateUserLocal(editUser.id, { role: editRole, pin_length_required: result.pin_length_required } as never);
          markUserPinReset(editUser.id);
          appendLog({
            action: 'user_role_changed',
            entity_type: 'user',
            entity_id: editUser.id,
            user_id: adminId,
            note: `${editUser.name}: ${editUser.role} → ${editRole}`,
            team_id: null, from_location_id: null, to_location_id: null,
            quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
          });
          if (Object.keys(otherFields).length > 0) {
            const now = updateUserLocal(editUser.id, otherFields as never);
            appendOutbox('UPDATE', 'users', { id: editUser.id, ...otherFields, updated_at: now });
            appendLog({
              action: 'user_updated',
              entity_type: 'user',
              entity_id: editUser.id,
              user_id: adminId,
              note: `${editUser.name}: updated ${Object.keys(otherFields).join(', ')}`,
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
    // local update + outbox mirror + activity log all commit together; on any
    // failure nothing is written and we keep the sheet open so the admin can retry.
    try {
      runInTransaction(() => {
        const now = updateUserLocal(editUser.id, otherFields as never);
        appendOutbox('UPDATE', 'users', { id: editUser.id, ...otherFields, updated_at: now });
        if (roleChanged) {
          appendLog({
            action: 'user_role_changed',
            entity_type: 'user',
            entity_id: editUser.id,
            user_id: adminId,
            note: `${editUser.name}: ${editUser.role} → ${editRole}`,
            team_id: null, from_location_id: null, to_location_id: null,
            quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
          });
        } else {
          appendLog({
            action: 'user_updated',
            entity_type: 'user',
            entity_id: editUser.id,
            user_id: adminId,
            note: `${editUser.name}: updated ${Object.keys(otherFields).join(', ')}`,
            team_id: null, from_location_id: null, to_location_id: null,
            quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
          });
        }
      });
    } catch (err) {
      Alert.alert('Could not save changes', (err as Error).message);
      return;
    }
    refresh();
    setEditUser(null);
  }

  function toggleActive() {
    if (!editUser) return;
    const next = editUser.active ? 0 : 1;
    const verb = next ? 'Reactivate' : 'Deactivate';
    Alert.alert(
      `${verb} ${editUser.name}?`,
      next
        ? 'They will be able to sign in again.'
        : 'They will be signed out and hidden from the login picker. You can reactivate them later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb, style: next ? 'default' : 'destructive',
          onPress: () => {
            // Row + outbox + log commit atomically; only mirror the new state
            // locally once the write succeeds, otherwise revert by doing nothing.
            try {
              runInTransaction(() => {
                const now = updateUserLocal(editUser.id, { active: next } as never);
                appendOutbox('UPDATE', 'users', { id: editUser.id, active: !!next, updated_at: now });
                appendLog({
                  action: 'user_updated',
                  entity_type: 'user',
                  entity_id: editUser.id,
                  user_id: sessionUser?.id ?? null,
                  note: `${editUser.name}: ${next ? 'reactivated' : 'deactivated'}`,
                  team_id: null, from_location_id: null, to_location_id: null,
                  quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
                });
              });
            } catch (err) {
              Alert.alert(`Could not ${verb.toLowerCase()} user`, (err as Error).message);
              return;
            }
            const updated = { ...editUser, active: next };
            setEditUser(updated);
            refresh();
          },
        },
      ],
    );
  }

  function resetPin() {
    if (!editUser) return;
    Alert.alert(
      `Reset ${editUser.name}'s PIN?`,
      'Their current PIN stops working immediately. They will set and confirm a brand-new PIN themselves the next time they sign in.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset PIN', style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await resetUserPinOnline(editUser.id);
              appendLog({
                action: 'user_pin_reset',
                entity_type: 'user',
                entity_id: editUser.id,
                user_id: sessionUser?.id ?? null,
                note: editUser.name,
                team_id: null, from_location_id: null, to_location_id: null,
                quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
              });
              setEditUser({ ...editUser, pin_set: 0 });
              refresh();
              Alert.alert('PIN reset', `${editUser.name} will set a new PIN at next sign-in.`);
            } catch (err) {
              Alert.alert('Could not reset PIN', (err as Error).message);
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  // Reissue + email a one-time access code for a user who hasn't set a PIN yet.
  // Only surfaced when pin_set is false (see the edit sheet). The returned code is
  // shown so the admin can relay it directly if the email didn't go out.
  function resetAccessCode() {
    if (!editUser) return;
    const onFile = editUser.email?.trim();
    Alert.alert(
      `Email ${editUser.name} an access code?`,
      onFile
        ? `A new one-time code will be sent to ${onFile} so they can set their PIN.`
        : `${editUser.name} has no email on file. Add one in the Email field above and save first, then try again.`,
      onFile
        ? [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Send code',
              onPress: async () => {
                setBusy(true);
                try {
                  const { emailed, code } = await resetEnrollmentCodeOnline(editUser.id);
                  appendLog({
                    action: 'user_pin_reset',
                    entity_type: 'user',
                    entity_id: editUser.id,
                    user_id: sessionUser?.id ?? null,
                    note: `${editUser.name}: access code reissued${emailed ? ' + emailed' : ' (email not sent)'}`,
                    team_id: null, from_location_id: null, to_location_id: null,
                    quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
                  });
                  Alert.alert(
                    emailed ? 'Access code emailed' : 'Access code ready (email not sent)',
                    (emailed
                      ? `A one-time code was emailed to ${onFile}.`
                      : `Email could not be sent — share this code with ${editUser.name} directly.`) +
                      `\n\nOne-time code: ${code}\n\nThey enter it in the app to set their PIN.`,
                  );
                } catch (err) {
                  Alert.alert('Could not send access code', (err as Error).message);
                } finally {
                  setBusy(false);
                }
              },
            },
          ]
        : [{ text: 'OK', style: 'cancel' }],
    );
  }

  // ── Bulk multi-select actions (gated on manage_users) ──────────────────────

  const roleOptions = useMemo<PickerOption[]>(
    () => ALL_ROLES.map(r => ({ id: r, label: ROLE_DISPLAY_NAMES[r], sublabel: `Tier ${ROLE_TIER[r]}` })),
    [],
  );
  const teamOptions = useMemo<PickerOption[]>(
    () => getAllTeams().map(t => ({ id: t.id, label: t.name, sublabel: t.type })),
    [users],
  );

  function bulkSetActive(active: boolean) {
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const adminId = sessionUser?.id ?? null;
    // Whole batch in ONE transaction — if any user fails, the entire set rolls
    // back so we never half-apply a bulk action. The failing user is named.
    try {
      runInTransaction(() => {
        for (const id of ids) {
          const u = users.find(x => x.id === id);
          try {
            setUserActive(id, active);
            appendLog({
              action: 'user_updated',
              entity_type: 'user',
              entity_id: id,
              user_id: adminId,
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
    const adminId = sessionUser?.id ?? null;
    // Move pin_length_required to the new role's minimum too — same as the
    // single-row edit (saveEdits), so a promotion can't keep a shorter PIN.
    const pinLen = roleMinPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]];

    // Split the selection by whether THIS user's move to `role` also changes
    // their required PIN length — only those need the online round-trip
    // (changeRoleOnline resets the PIN + issues a code server-side, exactly
    // like saveEdits' single-user decision). Same-length moves stay on the
    // offline-capable outbox path.
    const offlineIds: string[] = [];
    const onlineIds: string[] = [];
    for (const id of ids) {
      const u = users.find(x => x.id === id);
      if (u && u.pin_length_required !== pinLen) onlineIds.push(id);
      else offlineIds.push(id);
    }

    setBusy(true);

    // Offline-capable batch first — one transaction, same as before: a mid-loop
    // failure rolls every same-length change back so we never leave some users
    // promoted and others not.
    if (offlineIds.length > 0) {
      try {
        runInTransaction(() => {
          for (const id of offlineIds) {
            const u = users.find(x => x.id === id);
            try {
              setUserRole(id, role, pinLen);
              appendLog({
                action: 'user_role_changed',
                entity_type: 'user',
                entity_id: id,
                user_id: adminId,
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

    // Online round-trip per user whose PIN length changes — each call resets
    // that user's PIN and reissues an enrollment code server-side, so it can't
    // be folded into the transaction above. Sequential, like bulkResetPin;
    // tally successes/failures and collect codes to relay to each user.
    const codes: string[] = [];
    let onlineFail = 0;
    let lastErr = '';
    for (const id of onlineIds) {
      const u = users.find(x => x.id === id);
      try {
        const result = await changeRoleOnline(id, role);
        updateUserLocal(id, { role, pin_length_required: result.pin_length_required } as never);
        markUserPinReset(id);
        appendLog({
          action: 'user_role_changed',
          entity_type: 'user',
          entity_id: id,
          user_id: adminId,
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

  function bulkAddToTeam(teamId: string, teamLabel: string) {
    setShowBulkTeamPicker(false);
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    const adminId = sessionUser?.id ?? null;
    let added = 0;
    // Whole batch in one transaction — every member insert (+ its outbox/log)
    // commits together or none do, so a failure can't half-add the group.
    try {
      runInTransaction(() => {
        for (const id of ids) {
          const u = users.find(x => x.id === id);
          try {
            // INSERT OR IGNORE — null means the user was already on the team; skip its
            // outbox/log so we don't enqueue a no-op write (mirrors teams/[id].tsx).
            const result = addTeamMember(teamId, id, {}, adminId);
            if (result === null) continue;
            const { joined_at } = result;
            appendOutbox('INSERT', 'team_members', {
              team_id: teamId,
              user_id: id,
              team_permission_overrides: '{}',
              added_by: adminId,
              joined_at,
            });
            appendLog({
              user_id: adminId,
              team_id: teamId,
              action: 'team_member_added',
              entity_type: 'team',
              entity_id: teamId,
              from_location_id: null, to_location_id: null,
              quantity: null, unit: null, job_id: null,
              note: u?.name ?? id,
              metadata: JSON.stringify({ member_user_id: id }),
              device_id: null,
            });
            added++;
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
    Alert.alert('Added to team', `${added} user${added === 1 ? '' : 's'} added to ${teamLabel}.`);
  }

  function bulkResetPin() {
    if (isWriteBlocked()) return;
    const ids = [...sel.selected];
    if (ids.length === 0) return;
    Alert.alert(
      `Reset PIN for ${ids.length} user${ids.length === 1 ? '' : 's'}?`,
      'Their current PINs stop working immediately. Each user sets and confirms a new PIN at next sign-in. This requires a connection to the server.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset PIN', style: 'destructive',
          onPress: async () => {
            setBusy(true);
            const adminId = sessionUser?.id ?? null;
            let ok = 0, fail = 0;
            let lastErr = '';
            // Sequential — PIN reset is an online round-trip per user; surface a
            // success/failure tally (and the error if everything failed offline).
            for (const id of ids) {
              const u = users.find(x => x.id === id);
              try {
                await resetUserPinOnline(id); // already marks pin_set=0 locally
                appendLog({
                  action: 'user_pin_reset',
                  entity_type: 'user',
                  entity_id: id,
                  user_id: adminId,
                  note: u?.name ?? id,
                  team_id: null, from_location_id: null, to_location_id: null,
                  quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
                });
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
          },
        },
      ],
    );
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

  // Warn (don't block — real people can share a name) if a user already exists.
  const dupUser = useMemo(() => {
    const n = newName.trim().toLowerCase();
    return n ? users.find(u => u.name.trim().toLowerCase() === n) ?? null : null;
  }, [newName, users]);

  function resetCreateForm() {
    setNewName(''); setNewEmail(''); setNewRole('mitigation_technician'); setNewPin('');
  }

  async function doCreate() {
    let createdId: string | null = null;
    const email = newEmail.trim();
    setCreating(true);
    try {
      createdId = await createUserOnline(newName.trim(), newRole);
      // The account is created online (PIN-less); the optional email travels the
      // normal offline-capable user upsert/outbox path (mirrors name/expiry edits)
      // rather than the create POST, so a manage_users sync push carries it.
      if (createdId && email) {
        const now = updateUserLocal(createdId, { email } as never);
        appendOutbox('UPDATE', 'users', { id: createdId, email, updated_at: now });
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
        action: 'user_created',
        entity_type: 'user',
        entity_id: createdId,
        user_id: sessionUser?.id ?? null,
        note: `${newName.trim()} (${newRole})`,
        team_id: null, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
      });
    }
  }

  function handleCreate() {
    if (!newName.trim()) {
      Alert.alert('Missing Info', 'Enter the employee’s name.');
      return;
    }
    if (dupUser) {
      Alert.alert(
        'Name already exists',
        `A user named "${dupUser.name}" (${ROLE_DISPLAY_NAMES[dupUser.role as UserRole]}) already exists. Create another anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create anyway', onPress: doCreate },
        ]
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
    // Toggling to the role's CURRENT effective value clears the override (clean
    // reset) instead of storing a redundant key.
    if (nextVal === roleEffective) {
      delete overrides[permission];
    } else {
      overrides[permission] = nextVal;
    }
    // Override write (row + outbox) and the audit log commit together; on failure
    // we leave state untouched so the Switch springs back to its prior value.
    try {
      runInTransaction(() => {
        savePermissionOverrides(userId, overrides);
        appendLog({
          action: 'user_permission_changed',
          entity_type: 'user',
          entity_id: userId,
          user_id: sessionUser?.id ?? null,
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

  return (
    <>
      <Stack.Screen options={{ title: 'Users & Permissions', headerShown: true }} />
      <View style={s.container}>
        <View style={s.topBar}>
          <AppInput
            style={{ flex: 1 }}
            placeholder="Search users..."
            value={search}
            onChangeText={setSearch}
          />
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
                onPress={() => {
                  if (sel.active) sel.toggle(u.id);
                  else openEdit(u);
                }}
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
                  <View style={[s.statusPill, { backgroundColor: STATUS_META[st].bg }]}>
                    <Text style={[s.statusText, { color: STATUS_META[st].color }]}>{STATUS_META[st].label}</Text>
                  </View>
                )}
                <Text style={s.tier}>T{ROLE_TIER[u.role as UserRole]}</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={<Text style={s.empty}>No users found</Text>}
        />

        {/* Create modal */}
        <ModalSheet visible={showCreate} onClose={() => setShowCreate(false)}>
          <Text style={s.modalTitle}>New User</Text>
          <AppInput
            placeholder="Full name"
            value={newName}
            onChangeText={setNewName}
            style={{ marginBottom: spacing.xs }}
          />
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
            style={{ marginBottom: spacing.xs }}
          />
          <FieldLabel>Role</FieldLabel>
          {/* keyboardShouldPersistTaps so a role tap registers immediately even when the
              name keyboard is open (else the first tap is eaten by keyboard-dismiss). */}
          <ScrollView style={{ maxHeight: 160 }} keyboardShouldPersistTaps="handled">
            {ALL_ROLES.map(r => (
              <TouchableOpacity
                key={r}
                style={[s.roleRow, newRole === r && s.roleRowActive]}
                onPress={() => setNewRole(r)}
              >
                <Text style={[s.roleText, newRole === r && s.roleTextActive]}>
                  {ROLE_DISPLAY_NAMES[r]}
                </Text>
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
              // Client-side hierarchy gate (server enforces authoritatively): the
              // caller can only change the role/permissions/lifecycle of a user at
              // or below their own tier. Fail safe to locked if the session role
              // is missing.
              const callerRole = (sessionUser?.role ?? '') as UserRole;
              const canActOnUser = canActOnTarget(callerRole, editUser.role as UserRole);
              return (
                <>
                  <View style={s.sheetHead}>
                    <Text style={s.modalTitle}>{editUser.name}</Text>
                    <View style={[s.statusPill, { backgroundColor: STATUS_META[st].bg }]}>
                      <Text style={[s.statusText, { color: STATUS_META[st].color }]}>{STATUS_META[st].label}</Text>
                    </View>
                  </View>

                  {/* At-a-glance info */}
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

                  <FieldLabel>Role</FieldLabel>
                  {!canActOnUser && (
                    <Text style={s.lockNote}>
                      🔒 This user is at or above your access level — you can't change their role or permissions.
                    </Text>
                  )}
                  <TouchableOpacity
                    style={[s.selectRow, !canActOnUser && s.rowDisabled]}
                    onPress={() => { if (canActOnUser) setShowRolePicker(v => !v); }}
                    disabled={!canActOnUser}
                  >
                    <Text style={s.selectText}>{ROLE_DISPLAY_NAMES[editRole]}</Text>
                    <Text style={s.selectChevron}>{showRolePicker ? '▾' : '▸'}</Text>
                  </TouchableOpacity>
                  {canActOnUser && showRolePicker && (
                    <View style={s.rolePicker}>
                      {/* Only offer roles the caller may assign (at/below their own
                          effective tier). The current role stays visible so the
                          selection still shows even if it's above what they can grant. */}
                      {ALL_ROLES.filter(r => canAssignRole(callerRole, r) || r === editRole).map(r => (
                        <TouchableOpacity
                          key={r}
                          style={[s.roleRow, editRole === r && s.roleRowActive]}
                          onPress={() => { setEditRole(r); setShowRolePicker(false); }}
                        >
                          <Text style={[s.roleText, editRole === r && s.roleTextActive]}>{ROLE_DISPLAY_NAMES[r]}</Text>
                          <Text style={s.roleTierHint}>T{ROLE_TIER[r]}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  {/* Per-user home-screen dashboard assignment (Wave C). null =
                      fall back to the user's role dashboard. Same collapsible
                      picker + offline outbox save path as Role above. */}
                  <FieldLabel>Dashboard</FieldLabel>
                  <Text style={s.hint}>Which home-screen layout this user sees; Role default falls back to their role's dashboard.</Text>
                  <TouchableOpacity style={s.selectRow} onPress={() => setShowDashboardPicker(v => !v)}>
                    <Text style={s.selectText}>
                      {dashboardOptions.find(o => o.id === editDashboardPresetId)?.label ?? 'Role default'}
                    </Text>
                    <Text style={s.selectChevron}>{showDashboardPicker ? '▾' : '▸'}</Text>
                  </TouchableOpacity>
                  {showDashboardPicker && (
                    <View style={s.rolePicker}>
                      {dashboardOptions.map(o => (
                        <TouchableOpacity
                          key={o.id ?? '__role_default__'}
                          style={[s.roleRow, editDashboardPresetId === o.id && s.roleRowActive]}
                          onPress={() => { setEditDashboardPresetId(o.id); setShowDashboardPicker(false); }}
                        >
                          <Text style={[s.roleText, editDashboardPresetId === o.id && s.roleTextActive]}>{o.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}

                  {/* Temporary employees can be given/changed an auto-deactivation date */}
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

                  {/* Security & lifecycle actions */}
                  <FieldLabel>Account actions</FieldLabel>
                  <TouchableOpacity style={[s.actionBtn, busy && s.btnDisabled]} onPress={resetPin} disabled={busy}>
                    <Text style={s.actionIcon}>🔑</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.actionTitle}>Reset PIN</Text>
                      <Text style={s.actionSub}>User sets a new PIN at next sign-in (online)</Text>
                    </View>
                  </TouchableOpacity>
                  {/* Pre-onboarding only: a user who hasn't set a PIN can be
                      re-sent a one-time access code (their original may be lost). */}
                  {!editUser.pin_set && (
                    <TouchableOpacity style={[s.actionBtn, busy && s.btnDisabled]} onPress={resetAccessCode} disabled={busy}>
                      <Text style={s.actionIcon}>✉️</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={s.actionTitle}>Reset & email access code</Text>
                        <Text style={s.actionSub}>Send a new one-time code so they can set their PIN (online)</Text>
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
                    // Resolve each row once so the diff summary and the per-row
                    // markers share the exact same baseline (role default merged
                    // with the role-level override).
                    const rows = ALL_PERMISSIONS.map(perm => {
                      // Role's CURRENT effective value: ROLE_DEFAULTS merged with the
                      // role-level override (the dynamic default).
                      const roleEffective = perm in roleOv
                        ? roleOv[perm]
                        : (ROLE_DEFAULTS[editUser.role]?.[perm] ?? false);
                      const hasUserKey = perm in ov;
                      const effective = hasUserKey ? ov[perm] : roleEffective;
                      // Only a deviation from the role's current effective value is a
                      // real override.
                      const isModified = hasUserKey && ov[perm] !== roleEffective;
                      return { perm, roleEffective, effective, isModified };
                    });
                    const diffCount = rows.filter(r => r.isModified).length;
                    return (
                      <>
                        <Text
                          style={[s.overrideSummary, diffCount > 0 && s.overrideSummaryActive]}
                          accessibilityLabel={
                            diffCount === 0
                              ? `All permissions match the ${roleName} default`
                              : `${diffCount} permission${diffCount === 1 ? '' : 's'} differ from the ${roleName} default`
                          }
                        >
                          {diffCount === 0
                            ? `Matches ${roleName} default`
                            : `${diffCount} override${diffCount === 1 ? '' : 's'} differ from ${roleName} default`}
                        </Text>
                        {rows.map(({ perm, roleEffective, effective, isModified }) => {
                          const label = perm.replace(/_/g, ' ');
                          return (
                            <View key={perm} style={s.permRow}>
                              {isModified && <View style={s.overrideDot} />}
                              <View style={{ flex: 1 }}>
                                <Text style={s.permName}>{label}</Text>
                                {isModified && (
                                  <Text style={s.overrideBadge}>
                                    changed · role default {roleEffective ? 'on' : 'off'}
                                  </Text>
                                )}
                              </View>
                              <Switch
                                value={effective}
                                disabled={!canActOnUser}
                                onValueChange={() => handleTogglePermission(editUser.id, perm, !effective, roleEffective)}
                                trackColor={{ true: colors.primary, false: colors.border }}
                                accessibilityLabel={
                                  isModified
                                    ? `${label}, changed from ${roleName} default of ${roleEffective ? 'on' : 'off'}`
                                    : `${label}, matches ${roleName} default`
                                }
                              />
                            </View>
                          );
                        })}
                      </>
                    );
                  })()}

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
          <Text style={s.modalTitle}>Add {sel.count} user{sel.count === 1 ? '' : 's'} to team</Text>
          <SearchablePicker
            placeholder="Search teams..."
            options={teamOptions}
            value={null}
            onSelect={opt => bulkAddToTeam(opt.id, opt.label)}
          />
          <TouchableOpacity style={s.cancel} onPress={() => setShowBulkTeamPicker(false)}>
            <Text style={[s.cancelText, s.cancelStrong]}>Cancel</Text>
          </TouchableOpacity>
        </ModalSheet>

        {canManageUsers && sel.active && (
          <BulkActionBar
            count={sel.count}
            actions={bulkActions}
            onSelectAll={() => sel.selectAll(filtered.map(u => u.id))}
            onCancel={sel.exit}
            disabled={locked}
          />
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: { flexDirection: 'row', padding: spacing.md, gap: 10 },
  addBtn: { backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
  list: { padding: spacing.md, gap: 8 },
  listWithBar: { paddingBottom: 160 },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, padding: spacing.md, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
  },
  cardSelected: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  checkCircle: {
    width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkCircleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: '#fff', fontSize: fontSizes.sm, fontWeight: '800' },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: colors.primaryBgStrong, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: fontSizes.base, fontWeight: '700', color: colors.primary },
  name: { fontSize: fontSizes.md, fontWeight: '600', color: colors.textPrimary },
  role: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 1 },
  tier: {
    fontSize: fontSizes.sm, fontWeight: '700', color: colors.textMuted,
    backgroundColor: '#F1F5F9', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  chevron: { fontSize: 18, color: colors.textDisabled },
  empty: { textAlign: 'center', marginTop: 40, color: colors.textMuted, fontSize: fontSizes.body },
  modalTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.brand, marginBottom: 8 },
  roleSub: { fontSize: fontSizes.body2, color: colors.textSecondary, marginBottom: 12 },
  hint: { fontSize: fontSizes.caption, color: colors.textMuted, lineHeight: 17, marginBottom: 8 },
  roleRow: { paddingVertical: 9, paddingHorizontal: 10, borderRadius: 6 },
  roleRowActive: { backgroundColor: colors.primaryBg },
  roleText: { fontSize: fontSizes.body, color: '#475569' },
  roleTextActive: { color: colors.primaryText, fontWeight: '600' },
  cancel: { alignItems: 'center', paddingVertical: 10, flex: 1 },
  cancelText: { color: colors.textSecondary, fontSize: fontSizes.body },
  cancelStrong: { color: colors.textMuted, fontWeight: '600' },
  modalActions: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginTop: spacing.sm },
  dupWarn: { color: colors.warning, fontSize: fontSizes.caption, marginTop: -4 },
  infoBox: { backgroundColor: colors.primaryBg, borderRadius: radii.md, padding: spacing.md },
  infoText: { color: colors.primaryText, fontSize: fontSizes.body2, lineHeight: 19 },
  permRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#F1F5F9',
  },
  permName: { fontSize: fontSizes.body2, color: colors.textPrimary, textTransform: 'capitalize' },
  overrideBadge: { fontSize: fontSizes.xs, color: colors.accent, marginTop: 2, fontWeight: '600' },
  overrideDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginRight: 8 },
  overrideSummary: { fontSize: fontSizes.caption, color: colors.textMuted, fontWeight: '600', marginBottom: 6 },
  overrideSummaryActive: { color: colors.accent },

  cardMuted: { opacity: 0.6 },
  cardSub: { flexDirection: 'row', alignItems: 'center', marginTop: 1, gap: 4 },
  pinPending: { fontSize: fontSizes.sm, color: colors.warning, fontWeight: '600' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: fontSizes.sm, fontWeight: '700' },

  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: colors.background, borderRadius: radii.md, padding: spacing.md, rowGap: 6 },
  infoRow: { width: '50%', fontSize: fontSizes.caption, color: colors.textMuted },
  infoVal: { color: colors.textPrimary, fontWeight: '600' },
  selectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.base, height: 44 },
  selectText: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500' },
  selectChevron: { fontSize: fontSizes.base, color: colors.textMuted },
  rolePicker: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  roleTierHint: { fontSize: fontSizes.sm, fontWeight: '700', color: colors.textDisabled },
  expiryRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  expiryCurrent: { flex: 1, backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.base, height: 44, justifyContent: 'center' },
  expiryText: { fontSize: fontSizes.body, color: colors.textPrimary },
  expiryClear: { color: colors.danger, fontSize: fontSizes.body, fontWeight: '600', paddingHorizontal: 6 },
  chipWrap: { flexDirection: 'row', gap: 8 },
  expiryChip: { backgroundColor: colors.primaryBg, borderRadius: 16, paddingHorizontal: spacing.base, paddingVertical: 8 },
  expiryChipText: { color: colors.primaryText, fontSize: fontSizes.body2, fontWeight: '600' },
  btnDisabled: { opacity: 0.45 },
  rowDisabled: { opacity: 0.45 },
  lockNote: { fontSize: fontSizes.caption, color: colors.textMuted, lineHeight: 17, marginBottom: 6 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  actionIcon: { fontSize: 20 },
  actionTitle: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  actionSub: { fontSize: fontSizes.sm, color: colors.textMuted, marginTop: 1 },
  actionDanger: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
  actionGood: { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4' },
  dangerText: { color: colors.danger },
  goodText: { color: colors.success },
});
