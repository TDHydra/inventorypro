// NEW route this station — no old-app equivalent (the old app never had a
// standalone admin surface for unit_access; grants were only reachable via
// MemberPermissionsSheet or the (now-cut) LockerPanel). Backs the unit_access
// table directly: list every grant across active Locker units, filter by
// locker/person, grant/revoke. Vehicle units are out of scope this station
// (see repos/access.ts's header PORT NOTE) — this surface only ever shows
// Lockers, matching getAllUnitAccessGrants's own filter.
//
// Gated on manage_locations (the same permission personal-locker provisioning
// and grant creation already require) for both viewing and managing — there's
// no separate read-only "view access" permission in the role model.
import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useTheme, useThemedStyles, Card, EmptyState, ModalSheet, PrimaryButton,
  AppInput, FieldLabel, confirmSheet,
} from '@invenpro/ui';
import { useDbQuery, useDataVersion, runInTransaction, syncNow } from '@invenpro/core';
import {
  getAllUnitAccessGrants, revokeUnitAccess, grantUnitAccessWithDefaults, type UserUnitGrant,
} from '../../../src/repos/access';
import { getUnitLocations } from '../../../src/repos/locations';
import { getAllActiveUsers } from '../../../src/repos/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import type { UserRole } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';

export default function AccessScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { realUser } = useSession();
  const canManage = usePermission('manage_locations');
  const { locked } = useMaintenanceMode();

  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [showGrant, setShowGrant] = useState(false);
  const [grantUnit, setGrantUnit] = useState<PickerOption | null>(null);
  const [grantUser, setGrantUser] = useState<PickerOption | null>(null);

  const grants = useDbQuery(() => getAllUnitAccessGrants(), [], ['unit_access', 'locations', 'users']);

  const lockerOptions = useMemo<PickerOption[]>(
    () => getUnitLocations('Locker').map(l => ({ id: l.id, label: l.name })),
    [],
  );
  const userOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({
      id: u.id, label: u.name,
      sublabel: ROLE_DISPLAY_NAMES[u.role as UserRole] ?? u.role,
    })),
    [],
  );
  const userNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const opt of userOptions) m.set(opt.id, opt.label);
    return m;
  }, [userOptions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grants;
    return grants.filter(g =>
      g.location_name.toLowerCase().includes(q)
      || (userNameById.get(g.user_id) ?? g.user_id).toLowerCase().includes(q));
  }, [grants, query, userNameById]);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — nothing to sync */ }
    setRefreshing(false);
  };

  function resetGrantForm() {
    setGrantUnit(null);
    setGrantUser(null);
  }

  // grantUnitAccessWithDefaults doesn't self-log (repos/access.ts convention)
  // — this screen owns the appendLog call, matching the old app's shape.
  function handleGrant() {
    if (!grantUnit || !grantUser || isWriteBlocked()) return;
    const actorId = realUser?.id ?? null;
    const granteeRole = userOptions.find(u => u.id === grantUser.id)?.sublabel ?? '';
    try {
      runInTransaction(() => {
        grantUnitAccessWithDefaults(grantUnit.id, grantUser.id, granteeRole, actorId);
        appendLog({
          action: 'unit_access_granted', entity_type: 'location', entity_id: grantUnit.id,
          user_id: actorId, team_id: null, job_id: null,
          note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
          metadata: JSON.stringify({ grantee_user_id: grantUser.id }),
          device_id: null,
        });
      });
    } catch {
      Alert.alert('Could not grant access', 'Please try again.');
      return;
    }
    setShowGrant(false);
    resetGrantForm();
  }

  async function handleRevoke(g: UserUnitGrant) {
    const ok = await confirmSheet({
      title: 'Revoke', message: `Remove access to ${g.location_name} for this user?`,
      confirmLabel: 'Revoke', destructive: true,
    });
    if (!ok || isWriteBlocked()) return;
    runInTransaction(() => {
      revokeUnitAccess(g.location_id, g.user_id);
      appendLog({
        action: 'unit_access_revoked', entity_type: 'location', entity_id: g.location_id,
        user_id: null, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({ grantee_user_id: g.user_id }),
        device_id: null,
      });
    });
  }

  if (!canManage) {
    return (
      <>
        <Stack.Screen options={{ title: 'Access', headerShown: true }} />
        <PermissionGate permission="manage_locations" mode="screen" />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Access', headerShown: true }} />
      <View style={s.container}>
        <View style={s.topBar}>
          <AppInput
            style={s.search}
            placeholder="Filter by locker or user…"
            value={query}
            onChangeText={setQuery}
          />
          <TouchableOpacity style={s.addBtn} onPress={() => setShowGrant(true)} disabled={locked}>
            <Text style={s.addBtnText}>+ Grant</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.primary} colors={[t.colors.primary]} />
          }
        >
          {filtered.length === 0 ? (
            <EmptyState icon="🔐" title="No access grants" subtitle="Grant a locker to someone to see it here." />
          ) : (
            filtered.map(g => (
              <Card key={`${g.location_id}:${g.user_id}`} variant="list">
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>🔒 {g.location_name}</Text>
                    <Text style={s.sub}>{userNameById.get(g.user_id) ?? g.user_id}</Text>
                  </View>
                  <TouchableOpacity onPress={() => handleRevoke(g)} disabled={locked} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Text style={s.revoke}>Revoke</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))
          )}
        </ScrollView>

        <ModalSheet visible={showGrant} onClose={() => setShowGrant(false)} scroll={false}>
          <Text style={s.modalTitle}>Grant Locker Access</Text>
          <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <FieldLabel>Locker</FieldLabel>
            <SearchablePicker
              placeholder="Search lockers…"
              options={lockerOptions}
              value={grantUnit}
              onSelect={opt => setGrantUnit(prev => (prev?.id === opt.id ? null : opt))}
            />
            <FieldLabel>Person</FieldLabel>
            <SearchablePicker
              placeholder="Search people…"
              options={userOptions}
              value={grantUser}
              onSelect={opt => setGrantUser(prev => (prev?.id === opt.id ? null : opt))}
            />
            <PrimaryButton label="Grant" onPress={handleGrant} disabled={!grantUnit || !grantUser || locked} style={{ marginTop: 8 }} />
          </ScrollView>
        </ModalSheet>
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  search: { flex: 1 },
  addBtn: { backgroundColor: t.colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  addBtnText: { color: t.colors.primaryText, fontWeight: '700', fontSize: 14 },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  sub: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  revoke: { color: t.colors.danger, fontSize: 13, fontWeight: '600' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
});
