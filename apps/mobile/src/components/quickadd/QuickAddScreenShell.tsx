import { useRef, useState } from 'react';
import { View, Text, StyleSheet, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../hooks/usePermission';
import { PrimaryButton } from '../ui/PrimaryButton';
import { colors, spacing, fontSizes } from '../../theme';

/**
 * Shared chrome for a single Quick Add action screen: the `quick_add` permission
 * gate (deep-link safe), the screen header, a confirmation toast, and a per-session
 * counter. The *form* itself stays in each screen (render-prop `children(onSaved)`)
 * so every action can diverge freely without touching this shell.
 */
export function QuickAddScreenShell({
  title,
  children,
}: {
  title: string;
  children: (onSaved: (label: string) => void) => React.ReactNode;
}) {
  const canQuickAdd = usePermission('quick_add');
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!canQuickAdd) {
    return (
      <>
        <Stack.Screen options={{ title, headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>You don't have permission to quick add. Ask an admin to enable it for your role.</Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  function onSaved(label: string) {
    setCount(c => c + 1);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(`Added ${label}`);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {toast !== null && (
          <View style={s.toast}><Text style={s.toastText}>{toast}</Text></View>
        )}
        {count > 0 && (
          <View style={s.counterRow}><Text style={s.counterText}>Added {count} this session</Text></View>
        )}
        <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {children(onSaved)}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  toast: { backgroundColor: colors.success, paddingHorizontal: spacing.lg, paddingVertical: 10, alignItems: 'center' },
  toastText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
  counterRow: { paddingHorizontal: spacing.lg, paddingBottom: 6, paddingTop: 6, alignItems: 'center' },
  counterText: { fontSize: fontSizes.caption, color: colors.success, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: 48 },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxxl, backgroundColor: colors.background },
  gateTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  gateSub: { fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.xxl },
});
