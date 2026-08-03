import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useSession } from '../../hooks/useSession';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import { getUserById } from '../../db/queries/users';
import { ChangePinSheet } from './ChangePinSheet';
import { ChangeEmailSheet } from './ChangeEmailSheet';
import { ChangePhoneSheet } from './ChangePhoneSheet';
import { NotificationPrefsSheet } from './NotificationPrefsSheet';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * Settings → "My Profile" (role-dashboards spec §4): self-service PIN / email /
 * phone for EVERY role — no permission gate. Renders the same section-title +
 * card + rows shape as the rest of the Settings page so it slots in above the
 * gated sections. Email/phone rows show the current value from the local users
 * row, re-read on focus/data-version so a background sync (or the sheets'
 * local mirror + bumpDataVersion) updates them live.
 */
export function ProfileSection() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const refreshKey = useFocusOrDataRefresh();

  // Full local row — the session snapshot doesn't carry email/phone.
  const row = useMemo(
    () => (user ? getUserById(user.id) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey drives the re-read
    [user?.id, refreshKey],
  );

  const [showPin, setShowPin] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

  if (!user) return null;

  return (
    <View>
      <Text style={s.sectionTitle}>My Profile</Text>
      <View style={s.card}>
        <TouchableOpacity style={s.row} onPress={() => setShowPin(true)}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>🔒 Change PIN</Text>
            <Text style={s.rowSub}>Your sign-in PIN — checked on the server, never stored on this device.</Text>
          </View>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
        <View style={s.divider} />
        <TouchableOpacity style={s.row} onPress={() => setShowEmail(true)}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>📧 Email</Text>
            <Text style={s.rowSub}>{row?.email || 'Not set'}</Text>
          </View>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
        <View style={s.divider} />
        <TouchableOpacity style={s.row} onPress={() => setShowPhone(true)}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>📱 Phone</Text>
            <Text style={s.rowSub}>{row?.phone || 'Not set'}</Text>
          </View>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
        <View style={s.divider} />
        <TouchableOpacity style={s.row} onPress={() => setShowNotifications(true)}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowLabel}>🔔 My Notifications</Text>
            <Text style={s.rowSub}>Choose which push nudges reach this account.</Text>
          </View>
          <Text style={s.chevron}>›</Text>
        </TouchableOpacity>
      </View>

      <ChangePinSheet visible={showPin} onClose={() => setShowPin(false)} />
      <ChangeEmailSheet visible={showEmail} onClose={() => setShowEmail(false)} />
      <ChangePhoneSheet visible={showPhone} onClose={() => setShowPhone(false)} currentPhone={row?.phone ?? null} />
      <NotificationPrefsSheet visible={showNotifications} onClose={() => setShowNotifications(false)} />
    </View>
  );
}

// Mirrors the Settings screen's section styles (app/(app)/(admin)/settings.tsx
// makeStyles) so the section is visually indistinguishable from its neighbors.
const makeStyles = (t: Theme) => StyleSheet.create({
  sectionTitle: {
    fontSize: t.typography.fontSizes.caption,
    fontWeight: '700',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
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
});
