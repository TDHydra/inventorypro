// Station D3: ported from apps/mobile/src/components/profile/ProfileSection.tsx.
// Deviations from the old app: the "My Notifications" row (per-category push
// mutes, #245) moved to the dedicated settings/notifications page — the v2
// settings split gives notifications a whole surface, so a sheet-in-a-sheet
// entry point here would be a second path to the same switches. The
// onboarding-checklist row was never ported (login flow kept lean — plan
// decision, revisit at the parity gate).
import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useSession } from '../../hooks/useSession';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import { getUserById } from '../../repos/users';
import { ChangePinSheet } from './ChangePinSheet';
import { ChangeEmailSheet } from './ChangeEmailSheet';
import { ChangePhoneSheet } from './ChangePhoneSheet';

/**
 * Settings → "My Profile": self-service PIN / email / phone for EVERY role —
 * no permission gate. Renders the same section-title + card + rows shape as
 * the rest of the Settings page so it slots in above the gated sections.
 * Email/phone rows show the current value from the local users row, re-read
 * on focus/data-version so a background sync (or the sheets' local mirror)
 * updates them live.
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
      </View>

      <ChangePinSheet visible={showPin} onClose={() => setShowPin(false)} />
      <ChangeEmailSheet visible={showEmail} onClose={() => setShowEmail(false)} />
      <ChangePhoneSheet visible={showPhone} onClose={() => setShowPhone(false)} currentPhone={row?.phone ?? null} />
    </View>
  );
}

// Mirrors the Settings hub's section styles (app/(app)/settings/index.tsx
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
