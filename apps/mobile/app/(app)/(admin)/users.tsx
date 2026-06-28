import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ScrollView, Alert, Switch,
} from 'react-native';
import { Stack } from 'expo-router';
import {
  getAllUsers, updateUserLocal, markUserPinReset, getRoleSettings,
  getRolePermissionOverrides, User,
} from '../../../src/db/queries/users';
import {
  ROLE_DISPLAY_NAMES, UserRole, ROLE_TIER, PIN_LENGTH_BY_TIER, Permission,
  ROLE_DEFAULTS,
} from '../../../src/constants/roles';
import { appendOutbox } from '../../../src/sync/outbox';
import { getDb } from '../../../src/db/schema';
import { getValidJwt } from '../../../src/auth/session';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
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
  db.executeSync(
    `UPDATE users SET permission_overrides = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(overrides), now, userId]
  );
  appendOutbox('UPDATE', 'users', { id: userId, permission_overrides: overrides, updated_at: now });
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
  const [users, setUsers] = useState<User[]>(() => getAllUsers());
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('mitigation_technician');
  const [newPin, setNewPin] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit form state (initialised when an edit sheet opens)
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('mitigation_technician');
  const [editExpiry, setEditExpiry] = useState<string | null>(null);
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [busy, setBusy] = useState(false);

  const roleMinPins = useMemo(() => getRoleSettings(), [users]);
  // Per-role permission deviations (the dynamic role default). User overrides are
  // diffed against ROLE_DEFAULTS merged with these, so a user override only reads
  // as "modified" when it differs from the role's CURRENT effective value.
  const roleOverrides = useMemo(() => getRolePermissionOverrides(), [users]);

  function refresh() { setUsers(getAllUsers()); }

  function openEdit(u: User) {
    setEditUser(u);
    setEditName(u.name);
    setEditRole(u.role);
    setEditExpiry(u.expires_at);
    setShowRolePicker(false);
  }

  const editDirty = !!editUser && (
    editName.trim() !== editUser.name ||
    editRole !== editUser.role ||
    (editExpiry ?? null) !== (editUser.expires_at ?? null)
  );

  function saveEdits() {
    if (!editUser) return;
    if (!editName.trim()) { Alert.alert('Required', 'Name cannot be empty.'); return; }
    const fields: Record<string, unknown> = {};
    if (editName.trim() !== editUser.name) fields.name = editName.trim();
    if (editRole !== editUser.role) {
      fields.role = editRole;
      // Keep the required PIN length in step with the new role's minimum.
      fields.pin_length_required = roleMinPins[editRole] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[editRole]];
    }
    if ((editExpiry ?? null) !== (editUser.expires_at ?? null)) fields.expires_at = editExpiry;
    if (Object.keys(fields).length === 0) { setEditUser(null); return; }
    const roleChanged = editRole !== editUser.role;
    const otherFieldsChanged = editName.trim() !== editUser.name ||
      (editExpiry ?? null) !== (editUser.expires_at ?? null);
    const now = updateUserLocal(editUser.id, fields as never);
    appendOutbox('UPDATE', 'users', { id: editUser.id, ...fields, updated_at: now });
    const adminId = sessionUser?.id ?? null;
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
    }
    if (otherFieldsChanged && !roleChanged) {
      appendLog({
        action: 'user_updated',
        entity_type: 'user',
        entity_id: editUser.id,
        user_id: adminId,
        note: `${editUser.name}: updated ${Object.keys(fields).join(', ')}`,
        team_id: null, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
      });
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
    setNewName(''); setNewRole('mitigation_technician'); setNewPin('');
  }

  async function doCreate() {
    let createdId: string | null = null;
    setCreating(true);
    try {
      createdId = await createUserOnline(newName.trim(), newRole);
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
          contentContainerStyle={s.list}
          renderItem={({ item: u }) => {
            const st = userStatus(u);
            return (
              <TouchableOpacity style={[s.card, st !== 'active' && s.cardMuted]} onPress={() => openEdit(u)}>
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{u.name.charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{u.name}</Text>
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
          <FieldLabel>Role</FieldLabel>
          <ScrollView style={{ maxHeight: 160 }}>
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

                  <FieldLabel>Role</FieldLabel>
                  <TouchableOpacity style={s.selectRow} onPress={() => setShowRolePicker(v => !v)}>
                    <Text style={s.selectText}>{ROLE_DISPLAY_NAMES[editRole]}</Text>
                    <Text style={s.selectChevron}>{showRolePicker ? '▾' : '▸'}</Text>
                  </TouchableOpacity>
                  {showRolePicker && (
                    <View style={s.rolePicker}>
                      {ALL_ROLES.map(r => (
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

                  {/* Temporary employees can be given/changed an auto-deactivation date */}
                  {isTemp && (
                    <>
                      <FieldLabel>Access expires</FieldLabel>
                      <Text style={s.hint}>Temporary employees lose access automatically after this date.</Text>
                      <View style={s.expiryRow}>
                        <View style={s.expiryCurrent}>
                          <Text style={s.expiryText}>{editExpiry ? formatDate(editExpiry) : 'No expiry set'}</Text>
                        </View>
                        {editExpiry && (
                          <TouchableOpacity onPress={() => setEditExpiry(null)}>
                            <Text style={s.expiryClear}>Clear</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      <View style={s.chipWrap}>
                        {[30, 60, 90].map(days => (
                          <TouchableOpacity key={days} style={s.expiryChip} onPress={() => setEditExpiry(isoFromNowDays(days))}>
                            <Text style={s.expiryChipText}>+{days} days</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  )}

                  <PrimaryButton
                    label={editDirty ? 'Save Changes' : 'No Changes'}
                    onPress={saveEdits}
                    disabled={!editDirty}
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
                  <TouchableOpacity style={[s.actionBtn, editUser.active ? s.actionDanger : s.actionGood]} onPress={toggleActive}>
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
                    return ALL_PERMISSIONS.map(perm => {
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
                      return (
                        <View key={perm} style={s.permRow}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.permName}>{perm.replace(/_/g, ' ')}</Text>
                            {isModified && <Text style={s.overrideBadge}>override active</Text>}
                          </View>
                          <Switch
                            value={effective}
                            onValueChange={() => handleTogglePermission(editUser.id, perm, !effective, roleEffective)}
                            trackColor={{ true: colors.primary, false: colors.border }}
                          />
                        </View>
                      );
                    });
                  })()}

                  <TouchableOpacity style={s.cancel} onPress={() => setEditUser(null)}>
                    <Text style={[s.cancelText, s.cancelStrong]}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </ScrollView>
        </ModalSheet>
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
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, padding: spacing.md, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
  },
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
  overrideBadge: { fontSize: fontSizes.xs, color: '#F59E0B', marginTop: 2 },

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
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  actionIcon: { fontSize: 20 },
  actionTitle: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  actionSub: { fontSize: fontSizes.sm, color: colors.textMuted, marginTop: 1 },
  actionDanger: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
  actionGood: { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4' },
  dangerText: { color: colors.danger },
  goodText: { color: colors.success },
});
