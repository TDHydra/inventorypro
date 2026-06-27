import { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, Platform,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import ItemQuickAdd from '../../../src/components/quickadd/ItemQuickAdd';
import LocationQuickAdd from '../../../src/components/quickadd/LocationQuickAdd';
import EquipmentQuickAdd from '../../../src/components/quickadd/EquipmentQuickAdd';
import StockQuickAdd from '../../../src/components/quickadd/StockQuickAdd';
import { colors, spacing, fontSizes } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';

type Mode = 'item' | 'location' | 'equipment' | 'stock';

const MODES: { key: Mode; label: string }[] = [
  { key: 'item', label: 'Item' },
  { key: 'location', label: 'Location' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'stock', label: 'Stock' },
];

export default function QuickAddScreen() {
  // All hooks must be called before any early return (Rules of Hooks)
  const canDev = usePermission('system_settings');
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('item');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Permission gate — deep-link safe: renders "Not authorized" instead of navigating away
  if (!canDev) {
    return (
      <>
        <Stack.Screen options={{ title: 'Quick Add', headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>This screen requires administrator access.</Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  function onSaved(label: string) {
    setCounts(c => ({ ...c, [mode]: (c[mode] ?? 0) + 1 }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(`Added ${label}`);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  const count = counts[mode] ?? 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Quick Add', headerShown: true }} />
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Confirmation toast */}
        {toast !== null && (
          <View style={s.toast}>
            <Text style={s.toastText}>{toast}</Text>
          </View>
        )}

        {/* 4-way segmented control */}
        <View style={s.segRow}>
          {MODES.map(m => (
            <FilterChip
              key={m.key}
              label={m.label}
              active={mode === m.key}
              onPress={() => setMode(m.key)}
            />
          ))}
        </View>

        {/* Per-mode session counter */}
        {count > 0 && (
          <View style={s.counterRow}>
            <Text style={s.counterText}>Added {count} this session</Text>
          </View>
        )}

        {/* Active mode component */}
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
        >
          {mode === 'item' && <ItemQuickAdd onSaved={onSaved} />}
          {mode === 'location' && <LocationQuickAdd onSaved={onSaved} />}
          {mode === 'equipment' && <EquipmentQuickAdd onSaved={onSaved} />}
          {mode === 'stock' && <StockQuickAdd onSaved={onSaved} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Toast
  toast: {
    backgroundColor: colors.success,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    alignItems: 'center',
  },
  toastText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },

  // Segmented control row
  segRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    margin: spacing.md,
  },

  // Counter
  counterRow: { paddingHorizontal: spacing.lg, paddingBottom: 6, alignItems: 'center' },
  counterText: { fontSize: fontSizes.caption, color: colors.success, fontWeight: '700' },

  // Content scroll area
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 48 },

  // Permission gate
  gate: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: spacing.xxxl, backgroundColor: colors.background,
  },
  gateTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  gateSub: { fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xxl },
});
