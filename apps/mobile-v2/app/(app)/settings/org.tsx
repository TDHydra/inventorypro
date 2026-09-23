import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, themeList, AppInput } from '@invenpro/ui';
import { getAppConfig, setAppConfigLocal, appendOutbox } from '@invenpro/core';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { getOrgDefaultThemeId, setOrgDefaultTheme } from '../../../src/db/orgTheme';
import { FormMode, getFormModeDefault, setFormModeDefault } from '../../../src/db/formMode';
import { getMainStorageLocationId, setMainStorageLocation } from '../../../src/db/mainStorage';
import { getNonShelfLocations, getShelvesForParent, resolveLocationShelf } from '../../../src/repos/locations';
import { SearchablePicker } from '../../../src/components/SearchablePicker';
import type { PickerOption } from '../../../src/components/SearchablePicker';

// Station D3: Settings → Organization (system_settings gate). Org-wide
// defaults that sync to every device: default theme, default form mode, main
// storage area, the approval auto-flag threshold, and the Manage Types link.

const FORM_MODE_OPTIONS: { label: string; value: FormMode }[] = [
  { label: 'Simple', value: 'simple' },
  { label: 'Detailed', value: 'detailed' },
];

// Approval workflow: movements whose |qty| >= this value auto-flag an
// approval request server-side. Blank/0 disables the auto-flag.
const APPROVAL_THRESHOLD_KEY = 'approval_threshold_qty';

/**
 * Writes a synced `app_config` value: locally + through the outbox so it
 * reaches the server (INSERT is the outbox's full-row upsert op; the server
 * applies ON CONFLICT (key) DO UPDATE).
 */
function setAppConfigSynced(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', {
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

export default function OrgSettings() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const isAdmin = usePermission('system_settings');
  const refreshKey = useFocusOrDataRefresh();

  // Seeded state (settings-split convention): updated in each handler,
  // re-seeded on focus/data ticks so synced changes from another device show.
  const [orgThemeId, setOrgThemeId] = useState<string | null>(() => getOrgDefaultThemeId());
  const [formDefault, setFormDefaultState] = useState<FormMode>(() => getFormModeDefault());
  const [thresholdInput, setThresholdInput] = useState<string>(() => getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');

  // Main storage area (app-wide default stock location). Two-stage like Quick
  // Add: a location, plus a shelf when that location has shelves. Stored as a
  // single id (the shelf id when a shelf is chosen, else the location id).
  const [storageLoc, setStorageLoc] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).location);
  const [storageShelf, setStorageShelf] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).shelf);
  // Shelves are only reachable through the shelf sub-picker of their parent,
  // never as a first-class storage location (#70).
  const allLocations = useMemo(() => getNonShelfLocations(), [refreshKey]);
  const locationById = useMemo(() => new Map(allLocations.map(l => [l.id, l])), [allLocations]);
  const locationOptions = useMemo<PickerOption[]>(
    () => allLocations.map(l => ({ id: l.id, label: l.name, sublabel: l.parent_id ? locationById.get(l.parent_id)?.name : undefined })),
    [allLocations, locationById],
  );
  const storageLocHasShelves = (storageLoc ? locationById.get(storageLoc.id) : undefined)?.has_shelves === 1;
  const storageShelfOptions = useMemo<PickerOption[]>(
    () => (storageLocHasShelves && storageLoc) ? getShelvesForParent(storageLoc.id).map(sh => ({ id: sh.id, label: sh.name })) : [],
    [storageLocHasShelves, storageLoc, refreshKey],
  );

  useEffect(() => {
    setOrgThemeId(getOrgDefaultThemeId());
    setFormDefaultState(getFormModeDefault());
    setThresholdInput(getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');
    const st = resolveLocationShelf(getMainStorageLocationId());
    setStorageLoc(st.location);
    setStorageShelf(st.shelf);
  }, [refreshKey]);

  const handleSetFormDefault = (mode: FormMode) => {
    try {
      setFormModeDefault(mode);
      setFormDefaultState(mode);
    } catch { /* blocked write — ignore */ }
  };

  // Pick a storage location: toggle off if re-tapped (clears the setting);
  // else set it and reset the shelf. The location id is stored immediately
  // (shelf optional).
  function handleStorageLocationSelect(opt: PickerOption) {
    if (storageLoc?.id === opt.id) {
      setStorageLoc(null);
      setStorageShelf(null);
      try { setMainStorageLocation(null); } catch { /* blocked write — ignore */ }
      return;
    }
    setStorageLoc(opt);
    setStorageShelf(null);
    try { setMainStorageLocation(opt.id); } catch { /* blocked write — ignore */ }
  }

  // Pick/clear a shelf within the storage location → store the shelf id (or
  // fall back to the location id when the shelf is cleared).
  function handleStorageShelfSelect(opt: PickerOption) {
    const next = storageShelf?.id === opt.id ? null : opt;
    setStorageShelf(next);
    try { setMainStorageLocation(next ? next.id : (storageLoc?.id ?? null)); } catch { /* blocked write — ignore */ }
  }

  // Commits the approval threshold on blur. Blank clears it (auto-flag off);
  // otherwise it must be a positive integer. Reverts to last-known-good on
  // invalid non-blank input.
  const commitApprovalThreshold = () => {
    const raw = thresholdInput.trim();
    if (raw === '') {
      try { setAppConfigSynced(APPROVAL_THRESHOLD_KEY, ''); } catch { /* blocked write — ignore */ }
      setThresholdInput('');
      return;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      setThresholdInput(getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');
      return;
    }
    const value = String(n);
    try { setAppConfigSynced(APPROVAL_THRESHOLD_KEY, value); } catch { /* blocked write — ignore */ }
    setThresholdInput(value);
  };

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Organization' }} />
        <Text style={s.muted}>You don&apos;t have access to organization settings.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Organization' }} />

      {/* ── Org default theme (app_config, synced) ──────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Org default theme</Text>
        <View style={s.card}>
          {themeList().map((th, i) => (
            <View key={th.id}>
              {i > 0 && <View style={s.divider} />}
              <TouchableOpacity
                style={s.row}
                onPress={() => {
                  try { setOrgDefaultTheme(th.id, user?.id ?? null); setOrgThemeId(th.id); }
                  catch { /* blocked write — ignore */ }
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>{th.name}</Text>
                </View>
                {/* Palette preview: bg / surface / primary / accent */}
                {[th.colors.background, th.colors.surface, th.colors.primary, th.colors.accent].map((c, j) => (
                  <View key={j} style={[s.swatch, { backgroundColor: c, borderColor: th.colors.border }]} />
                ))}
                <Text style={[s.rowSub, s.checkCol]}>{orgThemeId === th.id ? '✓' : ''}</Text>
              </TouchableOpacity>
            </View>
          ))}
          <View style={s.divider} />
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>
              Applies to the sign-in screen, new installs, and everyone who hasn&apos;t picked their own theme. Personal picks always win.
            </Text>
          </View>
        </View>
      </View>

      {/* ── Default form mode (app_config, synced) ──────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Default form mode</Text>
        <View style={s.card}>
          <View style={s.chipRow}>
            {FORM_MODE_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, formDefault === opt.value && s.chipActive]}
                onPress={() => handleSetFormDefault(opt.value)}
              >
                <Text style={[s.chipText, formDefault === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.divider} />
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>Applies to all devices unless a user overrides it in their own settings.</Text>
          </View>
        </View>
      </View>

      {/* ── Main storage area (app_config, synced) ──────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Main storage area</Text>
        <View style={s.card}>
          <View style={s.inputBlock}>
            <Text style={s.rowSub}>New stock (e.g. Quick Add) defaults to this location. Pick a shelf if the area has them.</Text>
            <SearchablePicker
              placeholder="Search locations…"
              options={locationOptions}
              value={storageLoc}
              onSelect={handleStorageLocationSelect}
            />
            {storageLocHasShelves && (
              <SearchablePicker
                placeholder="Pick a shelf (e.g. A1)…"
                options={storageShelfOptions}
                value={storageShelf}
                onSelect={handleStorageShelfSelect}
              />
            )}
          </View>
        </View>
      </View>

      {/* ── Approvals (app_config, synced) ──────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Approvals</Text>
        <View style={s.card}>
          <View style={s.inputBlock}>
            <Text style={s.rowLabel}>Require approval for movements ≥ (blank = off)</Text>
            <Text style={s.rowSub}>Checkouts or transfers of this quantity or more auto-create an approval request for review.</Text>
            <AppInput
              value={thresholdInput}
              onChangeText={setThresholdInput}
              onEndEditing={commitApprovalThreshold}
              keyboardType="number-pad"
              placeholder="Off"
              style={{ width: 100 }}
            />
          </View>
        </View>
      </View>

      {/* ── Manage Types ─────────────────────────────────────────────── */}
      <View>
        <View style={s.card}>
          <TouchableOpacity style={s.row} onPress={() => router.push('/(app)/manage-types')}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowLabel}>⚙️ Manage Types</Text>
              <Text style={s.rowSub}>Edit job, team, location & equipment types (label + icon), synced to all devices.</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        </View>
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
  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },
  inputBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm },

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
