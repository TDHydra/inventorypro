import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';

export default function SettingsScreen() {
  const router = useRouter();
  const isAdmin = usePermission('system_settings');

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        {/* App info */}
        <View style={s.infoCard}>
          <Text style={s.appName}>InventoryPro</Text>
          <Text style={s.version}>App Settings</Text>
        </View>

        {/* Developer tools section (admin only) */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Developer Tools</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/quick-add')}
              >
                <Text style={s.rowLabel}>⚡ Quick Add</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 16, paddingBottom: 48 },

  infoCard: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', padding: 16 },
  appName: { fontSize: 18, fontWeight: '600', color: '#1E293B' },
  version: { fontSize: 13, color: '#94A3B8', marginTop: 4 },

  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  card: { backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E2E8F0', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 14 },
  rowLabel: { fontSize: 14, color: '#1E293B', fontWeight: '500' },
  chevron: { fontSize: 18, color: '#94A3B8', fontWeight: '300' },
});
