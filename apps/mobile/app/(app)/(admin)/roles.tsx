import { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import {
  ROLE_DISPLAY_NAMES, ROLE_TIER, ROLE_DEFAULTS, PIN_LENGTH_BY_TIER,
  UserRole, Permission,
} from '../../../src/constants/roles';
import { getRoleSettings, setRoleMinPin } from '../../../src/db/queries/users';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

// Order roles by tier (highest authority first) so the list reads top-down.
const ROLES_BY_TIER = [...ALL_ROLES].sort((a, b) => ROLE_TIER[b] - ROLE_TIER[a] || a.localeCompare(b));

const PERMISSION_LABELS: Record<Permission, string> = {
  checkout_inventory: 'Check out inventory',
  checkin_inventory: 'Check in inventory',
  add_inventory: 'Add catalog items',
  edit_inventory: 'Edit catalog items',
  delete_inventory: 'Delete catalog items',
  transfer_between_locations: 'Transfer between locations',
  create_jobs: 'Create jobs',
  close_jobs: 'Close jobs',
  manage_locations: 'Manage locations',
  upload_media: 'Upload photos/video',
  view_all_logs: 'View all activity logs',
  view_own_logs: 'View own activity logs',
  manage_teams: 'Manage teams',
  checkout_for_team: 'Check out for a team',
  manage_users: 'Manage users',
  set_pins: 'Set / reset PINs',
  manage_roles_permissions: 'Manage roles & permissions',
  view_financial_data: 'View financial data',
  system_settings: 'Change system settings',
};

const PERMISSION_ORDER = Object.keys(PERMISSION_LABELS) as Permission[];

const MIN_PIN = 4;
const MAX_PIN = 8;

export default function RolesScreen() {
  const canManage = usePermission('manage_roles_permissions');
  const [minPins, setMinPins] = useState<Record<string, number>>(() => getRoleSettings());
  const [expanded, setExpanded] = useState<string | null>(null);

  const grantedCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const role of ALL_ROLES) {
      out[role] = PERMISSION_ORDER.filter(p => ROLE_DEFAULTS[role][p]).length;
    }
    return out;
  }, []);

  function effectiveMinPin(role: UserRole): number {
    return minPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]];
  }

  function changeMinPin(role: UserRole, delta: number) {
    if (!canManage) return;
    const next = Math.min(MAX_PIN, Math.max(MIN_PIN, effectiveMinPin(role) + delta));
    if (next === effectiveMinPin(role)) return;
    const now = setRoleMinPin(role, next);
    appendOutbox('UPDATE', 'role_settings', { role, min_pin_length: next, updated_at: now });
    setMinPins(prev => ({ ...prev, [role]: next }));
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Roles & Permissions', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <Text style={s.intro}>
          Each role grants a default set of permissions (read-only here) and a minimum PIN length.
          Per-user exceptions live on each user’s profile.
        </Text>

        {ROLES_BY_TIER.map(role => {
          const isOpen = expanded === role;
          const minPin = effectiveMinPin(role);
          return (
            <View key={role} style={s.card}>
              <TouchableOpacity style={s.cardHead} onPress={() => setExpanded(isOpen ? null : role)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.roleName}>{ROLE_DISPLAY_NAMES[role]}</Text>
                  <Text style={s.roleMeta}>
                    {grantedCounts[role]} of {PERMISSION_ORDER.length} permissions
                  </Text>
                </View>
                <Text style={s.tierBadge}>T{ROLE_TIER[role]}</Text>
                <Text style={s.chevron}>{isOpen ? '▾' : '▸'}</Text>
              </TouchableOpacity>

              {/* Min PIN length stepper */}
              <View style={s.pinRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.pinLabel}>Minimum PIN length</Text>
                  <Text style={s.pinHint}>Enforced when this role sets their PIN</Text>
                </View>
                <View style={s.stepper}>
                  <TouchableOpacity
                    style={[s.stepBtn, (!canManage || minPin <= MIN_PIN) && s.stepBtnOff]}
                    onPress={() => changeMinPin(role, -1)}
                    disabled={!canManage || minPin <= MIN_PIN}
                  >
                    <Text style={s.stepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={s.pinValue}>{minPin}</Text>
                  <TouchableOpacity
                    style={[s.stepBtn, (!canManage || minPin >= MAX_PIN) && s.stepBtnOff]}
                    onPress={() => changeMinPin(role, +1)}
                    disabled={!canManage || minPin >= MAX_PIN}
                  >
                    <Text style={s.stepText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Permission matrix (read-only) */}
              {isOpen && (
                <View style={s.matrix}>
                  {PERMISSION_ORDER.map(perm => {
                    const granted = ROLE_DEFAULTS[role][perm];
                    return (
                      <View key={perm} style={s.permRow}>
                        <Text style={[s.permCheck, granted ? s.permYes : s.permNo]}>
                          {granted ? '✓' : '·'}
                        </Text>
                        <Text style={[s.permLabel, !granted && s.permLabelOff]}>
                          {PERMISSION_LABELS[perm]}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {!canManage && (
          <Text style={s.readOnly}>
            👁 You can view roles but not change them. PIN-length controls are disabled.
          </Text>
        )}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  intro: { fontSize: 13, color: '#64748B', lineHeight: 19, marginBottom: 2 },

  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
  roleName: { fontSize: 16, fontWeight: '600', color: '#1E293B' },
  roleMeta: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  tierBadge: { fontSize: 11, fontWeight: '700', color: '#2563EB', backgroundColor: '#DBEAFE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  chevron: { fontSize: 16, color: '#94A3B8' },

  pinRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
  pinLabel: { fontSize: 13, color: '#1E293B', fontWeight: '500' },
  pinHint: { fontSize: 11, color: '#94A3B8', marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F1F5F9', borderRadius: 10 },
  stepBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  stepBtnOff: { opacity: 0.3 },
  stepText: { fontSize: 22, color: '#1D4ED8', fontWeight: '600' },
  pinValue: { fontSize: 16, fontWeight: '700', color: '#1E293B', minWidth: 24, textAlign: 'center' },

  matrix: { borderTopWidth: 1, borderTopColor: '#F1F5F9', paddingHorizontal: 14, paddingVertical: 8 },
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permCheck: { width: 18, textAlign: 'center', fontSize: 14, fontWeight: '700' },
  permYes: { color: '#16A34A' },
  permNo: { color: '#CBD5E1' },
  permLabel: { fontSize: 13, color: '#1E293B' },
  permLabelOff: { color: '#94A3B8' },

  readOnly: { fontSize: 13, color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 19 },
});
