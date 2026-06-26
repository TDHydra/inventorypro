import { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import ItemQuickAdd from '../../../src/components/quickadd/ItemQuickAdd';
import LocationQuickAdd from '../../../src/components/quickadd/LocationQuickAdd';
import EquipmentQuickAdd from '../../../src/components/quickadd/EquipmentQuickAdd';
import StockQuickAdd from '../../../src/components/quickadd/StockQuickAdd';

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
          <TouchableOpacity style={s.gateBtn} onPress={() => router.back()}>
            <Text style={s.gateBtnText}>Go back</Text>
          </TouchableOpacity>
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
            <TouchableOpacity
              key={m.key}
              style={[s.seg, mode === m.key && s.segActive]}
              onPress={() => setMode(m.key)}
            >
              <Text style={[s.segText, mode === m.key && s.segTextActive]}>{m.label}</Text>
            </TouchableOpacity>
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
  container: { flex: 1, backgroundColor: '#F8FAFF' },

  // Toast
  toast: {
    backgroundColor: '#16A34A',
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  toastText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Segmented control
  segRow: {
    flexDirection: 'row',
    backgroundColor: '#F1F5F9',
    margin: 12,
    borderRadius: 12,
    padding: 4,
  },
  seg: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
  },
  segActive: { backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, elevation: 2 },
  segText: { fontSize: 13, fontWeight: '600', color: '#64748B' },
  segTextActive: { color: '#1D4ED8' },

  // Counter
  counterRow: { paddingHorizontal: 16, paddingBottom: 6, alignItems: 'center' },
  counterText: { fontSize: 12, color: '#16A34A', fontWeight: '700' },

  // Content scroll area
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 48 },

  // Permission gate
  gate: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, backgroundColor: '#F8FAFF',
  },
  gateTitle: { fontSize: 20, fontWeight: '700', color: '#1E293B', marginBottom: 8 },
  gateSub: { fontSize: 14, color: '#64748B', textAlign: 'center', marginBottom: 24 },
  gateBtn: {
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingHorizontal: 24, paddingVertical: 12,
  },
  gateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
