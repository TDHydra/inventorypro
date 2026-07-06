import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { setAppConfigLocal } from '../../../src/db/appConfig';
import { appendOutbox } from '../../../src/sync/outbox';
import { NotificationRoutingEditor } from '../../../src/components/NotificationRoutingEditor';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';

// Writes a synced `app_config` value: locally + through the outbox so it reaches
// the server (same write path as settings.tsx's `setAppConfigSynced` — INSERT is
// the outbox's full-row upsert op; the server applies ON CONFLICT (key) DO UPDATE).
function setAppConfigSynced(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', {
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

// Standalone admin screen for notification routing (moved out of Settings). Gated
// on `system_settings` like the other admin sub-screens; frames each channel as
// "when X happens → these people/roles also get notified" for leadership.
export default function NotificationRoutingScreen() {
  const isAdmin = usePermission('system_settings');

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Notification Routing', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to notification routing.</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Notification Routing', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <View style={s.intro}>
          <Text style={s.introTitle}>Choose who gets notified for each event</Text>
          <Text style={s.introBody}>
            Each block below is an event — when it happens, InventoryPro already
            notifies the people it has to (the assignee, the low-stock admins, a
            user’s team manager, and so on). Add extra roles, teams, or specific
            people here to make sure the right leaders are always looped in.
          </Text>
          <Text style={s.introBody}>
            In short: <Text style={s.introEmph}>when X happens → these people get
            notified.</Text> These recipients are added on top of each event’s
            built-in ones.
          </Text>
        </View>
        <View style={s.card}>
          <NotificationRoutingEditor onSave={setAppConfigSynced} />
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
  introEmph: { fontWeight: '700', color: colors.textPrimary },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
});
