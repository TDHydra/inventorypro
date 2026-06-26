import { useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../src/hooks/useSession';
import { SyncIndicator } from '../../src/components/SyncIndicator';

export default function AppLayout() {
  const { user } = useSession();
  const router = useRouter();

  // Guard — redirect to login if no session
  useEffect(() => {
    if (!user) {
      router.replace('/(auth)/login');
    }
  }, [user]);

  if (!user) return null;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1E3A5F' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        headerRight: () => (
          <View style={styles.headerRight}>
            <SyncIndicator />
            <TouchableOpacity
              style={styles.switchBtn}
              onPress={() => router.push('/(auth)/login')}
            >
              <Text style={styles.switchText}>Switch</Text>
            </TouchableOpacity>
          </View>
        ),
      }}
    />
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 4 },
  switchBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  switchText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
