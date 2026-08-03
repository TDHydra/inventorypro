import { View, Text, Switch, StyleSheet } from 'react-native';
import { ModalSheet } from '../ui/ModalSheet';
import { useSession } from '../../hooks/useSession';
import { useDbQuery } from '../../hooks/useDbQuery';
import {
  NOTIFICATION_CATEGORIES,
  getNotificationPrefs,
  setNotificationCategoryPref,
  type NotificationCategory,
} from '../../db/userPrefs';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// Friendly labels for the 7 server-driven push categories (#245). low_stock
// and server_errors are deliberately absent — production/inventory-health
// alerts an individual can't silence for themselves alone (see
// db/userPrefs.ts's NOTIFICATION_CATEGORIES doc comment).
const CATEGORY_LABELS: Record<NotificationCategory, { label: string; sub: string }> = {
  assignment: { label: 'Assignments', sub: 'When you’re assigned a repair.' },
  chat: { label: 'Chat messages', sub: 'New messages in your conversations.' },
  schedule: { label: 'Schedule changes', sub: 'When your shift or schedule changes.' },
  approvals: { label: 'Approval requests', sub: 'Requests waiting on your decision, or decisions on yours.' },
  on_call: { label: 'On-call coverage', sub: 'Coverage changes on the on-call bench.' },
  checkout_idle: { label: 'Checkout idle reminders', sub: 'A team checkout that’s been sitting open.' },
  broadcast: { label: 'Announcements', sub: 'Company-wide broadcasts from admins.' },
};

/**
 * Settings → "My Profile" → My Notifications (#245). Self-service push-mute
 * per category, every role, no permission gate (same "My Profile" contract as
 * ChangePinSheet/ChangeEmailSheet/ChangePhoneSheet). Muting a category only
 * suppresses the PUSH nudge server-side (notifications.ts's filterMuted) —
 * the in-app inbox row still lands, same precedent as per-conversation
 * notify_pref in lib/push.ts's messageRecipients. No confirm needed: personal,
 * reversible, no blast radius.
 */
export function NotificationPrefsSheet({ visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const prefs = useDbQuery(
    () => (user ? getNotificationPrefs(user.id) : {}),
    [user?.id],
    ['user_prefs'],
  );

  if (!user) return null;

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.title}>🔔 My Notifications</Text>
      <Text style={s.intro}>
        Turn off push nudges for a category — it still shows up in your notification inbox, it just won’t buzz your phone.
      </Text>
      <View style={s.card}>
        {NOTIFICATION_CATEGORIES.map((category, i) => {
          const { label, sub } = CATEGORY_LABELS[category];
          const enabled = prefs[category] !== false;
          return (
            <View key={category}>
              {i > 0 && <View style={s.divider} />}
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>{label}</Text>
                  <Text style={s.rowSub}>{sub}</Text>
                </View>
                <Switch
                  value={enabled}
                  onValueChange={(v) => setNotificationCategoryPref(user.id, category, v)}
                />
              </View>
            </View>
          );
        })}
      </View>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: {
    fontSize: t.typography.fontSizes.lg,
    fontWeight: t.typography.weights.bold,
    color: t.colors.textPrimary,
    marginBottom: t.spacing.sm,
  },
  intro: {
    fontSize: t.typography.fontSizes.body2,
    color: t.colors.textSecondary,
    marginBottom: t.spacing.base,
  },
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
  rowSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
});
