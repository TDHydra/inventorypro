import { View, Text, ScrollView, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { useUnitAccessDefaults } from '../../../src/hooks/useUnitAccessDefaults';
import {
  setUnitAccessDefaults,
  notifyUnitAccessDefaultsChanged,
  FALLBACK_ACTIONS,
  type UnitAccessActions,
} from '../../../src/db/unitAccessDefaults';
import { ROLE_TIER, ROLE_DISPLAY_NAMES, type UserRole } from '../../../src/constants/roles';
import { runInTransaction } from '../../../src/db/tx';
import { isWriteBlocked } from '../../../src/db/maintenance';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// Standalone admin screen for the per-role unit_access grant defaults template
// (#122 Phase B). Gated on `system_settings` like the other admin sub-screens;
// each toggle commits immediately (hidden-fields idiom) and the reactive
// useUnitAccessDefaults hook keeps the switches live across sync pulls.
const ROLES_ORDERED = (Object.keys(ROLE_TIER) as UserRole[]).sort(
  (a, b) => ROLE_TIER[b] - ROLE_TIER[a] || ROLE_DISPLAY_NAMES[a].localeCompare(ROLE_DISPLAY_NAMES[b]),
);

const ACTION_LABELS: Record<keyof UnitAccessActions, string> = {
  view: 'See contents', add: 'Add stock', remove: 'Take stock', move: 'Move stock',
  editDetails: 'Edit details', grant: 'Grant access to others',
};
const ACTION_KEYS = Object.keys(ACTION_LABELS) as (keyof UnitAccessActions)[];

export default function UnitAccessDefaultsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const isAdmin = usePermission('system_settings');
  const defaults = useUnitAccessDefaults();   // reactive — sync pulls re-render this screen

  function handleToggle(role: UserRole, action: keyof UnitAccessActions, value: boolean) {
    if (isWriteBlocked()) return;
    const next = {
      ...defaults,
      [role]: { ...(defaults[role] ?? FALLBACK_ACTIONS), [action]: value },
    };
    try {
      runInTransaction(() => setUnitAccessDefaults(next));
    } catch (e) {
      Alert.alert('Could not save defaults', e instanceof Error ? e.message : 'Please try again.');
      return;
    }
    notifyUnitAccessDefaultsChanged();
  }

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Unit Access Defaults', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to unit access defaults.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Unit Access Defaults', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <View style={s.intro}>
          <Text style={s.introTitle}>New-grant defaults per role</Text>
          <Text style={s.introBody}>
            When someone is granted access to a vehicle or locker, their grant starts
            with these actions (based on their role). Individual grants can be edited
            afterwards from the member's permissions sheet.
          </Text>
        </View>
        {ROLES_ORDERED.map(role => {
          const actions = defaults[role] ?? FALLBACK_ACTIONS;
          return (
            <View key={role} style={s.card}>
              <Text style={s.roleTitle}>{ROLE_DISPLAY_NAMES[role]}</Text>
              {ACTION_KEYS.map((k, idx) => (
                <View key={k}>
                  {idx > 0 && <View style={s.divider} />}
                  <View style={s.row}>
                    <Text style={s.rowLabel}>{ACTION_LABELS[k]}</Text>
                    <Switch
                      value={actions[k]}
                      onValueChange={(v) => handleToggle(role, k, v)}
                      trackColor={{ true: t.colors.primary, false: t.colors.border }}
                    />
                  </View>
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl,
    backgroundColor: t.colors.background,
  },
  muted: {
    fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center',
  },

  intro: { gap: t.spacing.sm },
  introTitle: {
    fontSize: t.typography.fontSizes.lg,
    fontWeight: '700',
    color: t.colors.textPrimary,
  },
  introBody: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, lineHeight: 20 },

  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
  },

  roleTitle: { fontSize: 15, fontWeight: '700', color: t.colors.textPrimary, paddingTop: t.spacing.sm, paddingHorizontal: t.spacing.base },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.base,
  },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '500' },

  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
});
