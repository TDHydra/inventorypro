import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ModalSheet } from '../ui/ModalSheet';
import { NotificationPrefsSheet } from './NotificationPrefsSheet';
import { dismissOnboardingChecklist } from '../../db/userPrefs';
import { getPersonalLocker } from '../../access/personalLocker';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  userId: string;
  onClose: () => void;
}

/**
 * First-login onboarding checklist (#246). Shown once, triggered ONLY by
 * login.tsx's submitSetPin success branch writing 'pending' — see
 * db/userPrefs.ts's startOnboardingChecklist doc comment. Single-dismiss
 * model: one "Got it" button closes the whole checklist for good (no per-item
 * completion tracking, kept at "M" size).
 *
 * Rows are informational deep-links, not required steps — tapping one
 * navigates (or opens the relevant sheet directly) but doesn't dismiss the
 * checklist; only the explicit "Got it" button does.
 */
export function OnboardingChecklistSheet({ visible, userId, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [showNotifications, setShowNotifications] = useState(false);

  const hasLocker = !!getPersonalLocker(userId);

  const dismiss = () => {
    dismissOnboardingChecklist(userId);
    onClose();
  };

  return (
    <>
      <ModalSheet visible={visible} onClose={dismiss}>
        <Text style={s.title}>👋 Welcome aboard</Text>
        <Text style={s.intro}>A few things worth setting up:</Text>
        <View style={s.card}>
          <TouchableOpacity style={s.row} onPress={() => { onClose(); router.push('/(app)/(dashboard)'); }}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowLabel}>⭐ Star your favorite dashboard widgets</Text>
              <Text style={s.rowSub}>Pin the tiles you use most to the top of your dashboard.</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
          <View style={s.divider} />
          <TouchableOpacity style={s.row} onPress={() => setShowNotifications(true)}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowLabel}>🔔 Set your notification preferences</Text>
              <Text style={s.rowSub}>Choose which push nudges reach this account.</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
          {hasLocker && (
            <>
              <View style={s.divider} />
              <TouchableOpacity style={s.row} onPress={() => { onClose(); router.push('/(app)/(lockers)'); }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🔒 Check out your Locker</Text>
                  <Text style={s.rowSub}>Your personal storage location is ready.</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
        <TouchableOpacity style={s.gotIt} onPress={dismiss}>
          <Text style={s.gotItText}>Got it</Text>
        </TouchableOpacity>
      </ModalSheet>
      <NotificationPrefsSheet visible={showNotifications} onClose={() => setShowNotifications(false)} />
    </>
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
  chevron: { fontSize: 18, color: t.colors.textMuted, fontWeight: '300' },
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
  gotIt: {
    marginTop: t.spacing.base,
    backgroundColor: t.colors.primary,
    borderRadius: t.radii.md,
    paddingVertical: t.spacing.md,
    alignItems: 'center',
  },
  gotItText: { color: t.colors.onPrimary, fontWeight: t.typography.weights.bold, fontSize: t.typography.fontSizes.body },
});
