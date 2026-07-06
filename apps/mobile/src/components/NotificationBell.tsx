import { useState, useEffect, useCallback } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { countUnread } from '../db/queries/notifications';
import { useDataVersion } from '../hooks/useDataVersion';

// The inbox route. It is created in this same change (the (notifications) group)
// so expo-router's generated typed-routes may not list it until the dev server
// regenerates them — cast through Href to keep the imperative push type-safe
// against the route union without depending on stale generated types.
const INBOX_ROUTE = '/(app)/(notifications)' as Href;

// Header bell with an unread-count badge. Re-reads the count on every sync pull
// (via useDataVersion) AND on a short interval, so a locally marked-read row
// (which does not bump the data version) still clears the badge promptly.
export function NotificationBell() {
  const router = useRouter();
  const dataVersion = useDataVersion();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    try {
      setCount(countUnread());
    } catch {
      /* db not ready / mid-migration — leave the last known count */
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [refresh, dataVersion]);

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
