import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import Constants from 'expo-constants';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, themeList } from '@invenpro/ui';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { chooseTheme } from '../../../src/db/userPrefs';
import {
  FormMode, getFormMode, getFormModeOverride, setFormModeOverride,
} from '../../../src/db/formMode';
import { ProfileSection } from '../../../src/components/profile/ProfileSection';

// Station D3: the settings HUB — the old app's 1111-line admin settings.tsx
// split per the plan into settings/{sync,notifications,security,org,fields,
// access-defaults}. This page keeps only what's personal and device-local
// (account, profile, theme, form-detail override, app info) plus the links.
// Dropped WITH the split (plan decision #3): analytics, audit-log, broadcast,
// label designer, dashboards designer, sample-data dev tool.

const FORM_OVERRIDE_OPTIONS: { label: string; value: FormMode | null }[] = [
  { label: 'Simple', value: 'simple' },
  { label: 'Detailed', value: 'detailed' },
  { label: 'Use app default', value: null },
];

interface LinkRow { icon: string; label: string; sub: string; href: Href }
const LINKS: LinkRow[] = [
  { icon: '🔄', label: 'Sync & Data', sub: 'Status, pending changes, sync now.', href: '/(app)/settings/sync' },
  { icon: '🔔', label: 'Notifications', sub: 'Alerts, quiet hours, and what buzzes your phone.', href: '/(app)/settings/notifications' },
  { icon: '🛡️', label: 'Security', sub: 'Idle auto-logout, maintenance mode, QR label signing.', href: '/(app)/settings/security' },
];
const ADMIN_LINKS: LinkRow[] = [
  { icon: '🏢', label: 'Organization', sub: 'Org theme, form defaults, main storage, approvals.', href: '/(app)/settings/org' },
  { icon: '🙈', label: 'Hidden Fields', sub: 'Hide optional fields for all users on all devices.', href: '/(app)/settings/fields' },
  { icon: '🔑', label: 'Unit Access Defaults', sub: 'What a new vehicle/locker grant allows, per role.', href: '/(app)/settings/access-defaults' },
];

export default function SettingsHub() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user, realUser, logout } = useSession();
  const isAdmin = usePermission('system_settings');
  const refreshKey = useFocusOrDataRefresh();

  // Device form-detail override — app_settings writes don't bump the data
  // version (device-local, never synced), so this is plain state re-seeded on
  // focus/data ticks and updated in the tap handler.
  const [formOverride, setFormOverrideState] = useState<FormMode | null>(() => getFormModeOverride());
  const [formResolved, setFormResolvedState] = useState<FormMode>(() => getFormMode());
  useEffect(() => {
    setFormOverrideState(getFormModeOverride());
    setFormResolvedState(getFormMode());
  }, [refreshKey]);
  const handleSetFormOverride = (mode: FormMode | null) => {
    try {
      setFormModeOverride(mode);
      setFormOverrideState(mode);
      setFormResolvedState(getFormMode());
    } catch { /* blocked write — ignore */ }
  };

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

  if (!user) return null;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Settings' }} />

      {/* ── Account ──────────────────────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Account</Text>
        <View style={s.card}>
          <View style={s.infoBlock}>
            <Text style={s.rowLabel}>{user.name}</Text>
            <Text style={s.rowSub}>{ROLE_DISPLAY_NAMES[user.role] ?? user.role}</Text>
          </View>
          <View style={s.divider} />
          <TouchableOpacity style={s.row} onPress={() => { void logout(); }}>
            <Text style={[s.rowLabel, s.danger]}>Log out</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── My Profile (ALL roles — self-service PIN / email / phone) ── */}
      <ProfileSection />

      {/* ── Sub-pages ───────────────────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>More Settings</Text>
        <View style={s.card}>
          {[...LINKS, ...(isAdmin ? ADMIN_LINKS : [])].map((link, i) => (
            <View key={link.label}>
              {i > 0 && <View style={s.divider} />}
              <TouchableOpacity style={s.row} onPress={() => router.push(link.href)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>{link.icon} {link.label}</Text>
                  <Text style={s.rowSub}>{link.sub}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      </View>

      {/* ── Theme (per user, synced) ──────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Theme</Text>
        <View style={s.card}>
          {themeList().map((th, i) => (
            <View key={th.id}>
              {i > 0 && <View style={s.divider} />}
              <TouchableOpacity
                style={s.row}
                onPress={() => { if (realUser) chooseTheme(realUser.id, th.id); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>{th.name}</Text>
                </View>
                {/* Palette preview: bg / surface / primary / accent */}
                {[th.colors.background, th.colors.surface, th.colors.primary, th.colors.accent].map((c, j) => (
                  <View key={j} style={[s.swatch, { backgroundColor: c, borderColor: th.colors.border }]} />
                ))}
                <Text style={[s.rowSub, s.checkCol]}>{t.id === th.id ? '✓' : ''}</Text>
              </TouchableOpacity>
            </View>
          ))}
          <View style={s.divider} />
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>Synced to your account — follows you across devices.</Text>
          </View>
        </View>
      </View>

      {/* ── Form detail (this device) ─────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Form detail (this device)</Text>
        <View style={s.card}>
          <View style={s.chipRow}>
            {FORM_OVERRIDE_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.label}
                style={[s.chip, formOverride === opt.value && s.chipActive]}
                onPress={() => handleSetFormOverride(opt.value)}
              >
                <Text style={[s.chipText, formOverride === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.divider} />
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>Effective: {formResolved === 'simple' ? 'Simple' : 'Detailed'}</Text>
          </View>
        </View>
      </View>

      {/* ── App info ─────────────────────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>App Info</Text>
        <View style={s.card}>
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>Version: {appVersion}</Text>
            <Text style={s.rowSub} numberOfLines={1} ellipsizeMode="tail">API: {apiUrl}</Text>
            <Text style={s.rowSub}>User ID: {user.id}</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

// The shared section-title/card/row/chip shapes below are the settings-split
// house style — sync/notifications/security/org/fields/access-defaults copy
// them so every page in the split reads as one surface.
const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

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
  danger: { color: t.colors.danger },
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },

  swatch: { width: 18, height: 18, borderRadius: 9, borderWidth: 1, marginLeft: 4 },
  checkCol: { marginLeft: t.spacing.md, width: 18 },

  chipRow: { flexDirection: 'row', padding: t.spacing.md, gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: t.radii.sm,
    borderWidth: 1,
    borderColor: t.colors.textDisabled,
    backgroundColor: t.colors.background,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: t.colors.brand, borderColor: t.colors.brand },
  chipText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: '#475569' },
  chipTextActive: { color: t.colors.onPrimary },
});
