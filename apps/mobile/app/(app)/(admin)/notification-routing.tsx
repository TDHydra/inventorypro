import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { setAppConfigLocal } from '../../../src/db/appConfig';
import { appendOutbox } from '../../../src/sync/outbox';
import { NotificationRoutingEditor } from '../../../src/components/NotificationRoutingEditor';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

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
  const s = useThemedStyles(makeStyles);
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
  introEmph: { fontWeight: '700', color: t.colors.textPrimary },

  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.base,
  },
});
