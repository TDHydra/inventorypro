import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useDbQuery } from '@invenpro/core';
import { countUnread } from '../repos/notifications';

// Ported from apps/mobile/src/components/NotificationBell.tsx. Header bell
// with an unread-count badge, wired into app/(app)/_layout.tsx's headerRight
// (Station B4) — same entry point the old app used (ChatBell/SyncIndicator
// aren't ported yet, so this sits alone next to Switch/Sign out).
const INBOX_ROUTE = '/(app)/notifications' as Href;

export function NotificationBell() {
  const router = useRouter();
  const count = useDbQuery(() => {
    try {
      return countUnread();
    } catch {
      return 0; // db not ready / mid-migration
    }
  }, [], ['notifications']);

  const badge = count > 99 ? '99+' : String(count);

  return (
    <TouchableOpacity
      style={styles.wrap}
      onPress={() => router.push(INBOX_ROUTE)}
      accessibilityLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      hitSlop={8}
    >
      <Text style={styles.bell}>🔔</Text>
      {count > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 6, justifyContent: 'center', alignItems: 'center' },
  bell: { fontSize: 18 },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
