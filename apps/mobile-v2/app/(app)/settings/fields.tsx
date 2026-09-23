import { View, Text, ScrollView, StyleSheet, Switch } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, Alert } from '@invenpro/ui';
import { runInTransaction } from '@invenpro/core';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useHiddenFields } from '../../../src/hooks/useHiddenFields';
import { toggleHiddenField, notifyHiddenFieldsChanged } from '../../../src/db/hiddenFields';
import { FormFieldId, ALL_FORM_FIELD_IDS, FORM_FIELD_LABELS } from '../../../src/constants/formFields';

// Station D3: Settings → Hidden Fields — port of the old app's standalone
// hidden-fields admin screen. Gated on `system_settings`. Fields toggled on
// here are hidden for all users on all devices; the reactive useHiddenFields
// hook keeps the switches live without waiting for a focus event or sync pull.
export default function HiddenFieldsSettings() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const { hiddenFields } = useHiddenFields();

  // Toggle a single optional field's hidden state. Wraps the write + activity
  // log in a transaction, then notifies subscribers so HidableField components
  // re-render immediately without waiting for a sync.
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
        <Stack.Screen options={{ title: 'Hidden Fields' }} />
        <Text style={s.muted}>You don&apos;t have access to hidden fields.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Hidden Fields' }} />
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
                trackColor={{ true: t.colors.primary, false: t.colors.border }}
              />
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// Settings-split house style — see app/(app)/settings/index.tsx makeStyles.
const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl,
    backgroundColor: t.colors.background,
  },
  muted: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center' },

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
