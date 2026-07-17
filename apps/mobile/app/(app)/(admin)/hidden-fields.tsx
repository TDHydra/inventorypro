import { View, Text, ScrollView, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useHiddenFields } from '../../../src/hooks/useHiddenFields';
import { toggleHiddenField, notifyHiddenFieldsChanged } from '../../../src/db/hiddenFields';
import { FormFieldId, ALL_FORM_FIELD_IDS, FORM_FIELD_LABELS } from '../../../src/constants/formFields';
import { runInTransaction } from '../../../src/db/tx';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';

// Standalone admin screen for hiding optional form fields (moved out of Settings).
// Gated on `system_settings` like the other admin sub-screens. Fields toggled on
// here are hidden for all users on all devices; the reactive useHiddenFields hook
// keeps the switches live without waiting for a focus event or sync pull.
export default function HiddenFieldsScreen() {
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const { hiddenFields } = useHiddenFields();

  // Toggle a single optional field's hidden state. Wraps the write + activity
  // log in a transaction (mirrors roles.tsx togglePerm) then notifies subscribers
  // so HidableField components re-render immediately without waiting for a sync.
  const handleToggleHiddenField = (id: FormFieldId, hidden: boolean) => {
    try {
      runInTransaction(() => {
        toggleHiddenField(id, hidden, user?.id ?? null);
      });
    } catch (e) {
      Alert.alert(
        'Could not update field visibility',
        e instanceof Error ? e.message : 'The change was not saved. Please try again.',
      );
      return;
    }
    notifyHiddenFieldsChanged();
  };

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Hidden Fields', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to hidden fields.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Hidden Fields', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <View style={s.intro}>
          <Text style={s.introTitle}>Hide optional fields</Text>
          <Text style={s.introBody}>
            Fields toggled on below are hidden for all users on all devices. Only
            optional fields can be hidden.
          </Text>
        </View>
        <View style={s.card}>
          {ALL_FORM_FIELD_IDS.map((id, idx) => (
            <View key={id}>
              {idx > 0 && <View style={s.divider} />}
              <View style={s.row}>
                <Text style={s.rowLabel}>{FORM_FIELD_LABELS[id]}</Text>
                <Switch
                  value={hiddenFields.has(id)}
                  onValueChange={(v) => handleToggleHiddenField(id, v)}
                  trackColor={{ true: colors.primary, false: colors.border }}
                />
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
    backgroundColor: colors.background,
  },
  muted: {
    fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center',
  },

  intro: { gap: spacing.sm },
  introTitle: {
    fontSize: fontSizes.lg,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  introBody: { fontSize: fontSizes.body2, color: colors.textSecondary, lineHeight: 20 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
  rowLabel: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500' },

  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.base },
});
