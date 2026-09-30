import { useEffect } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useTotalUnread, loadChatCache } from '../chat/store';
import { totalUnread } from '../db/queries/chat';
import { useDbQuery } from '../hooks/useDbQuery';
import { useSession } from '../hooks/useSession';

// Cast through Href for the same reason as NotificationBell's INBOX_ROUTE: the
// generated typed-routes union may lag a freshly added group.
const CHAT_ROUTE = '/(app)/(chat)' as Href;

// Header chat icon with a total-unread badge — a clone of NotificationBell, but
// the count comes from the reactive chat store (useTotalUnread). Re-reads on a
// messages/media table bump (#64 — chatPurge.ts and the pull path both bump
// these specifically) AND on a short interval, so a conversation marked read
// locally (which doesn't bump any table version) clears promptly.
export function ChatBell() {
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;
  const count = useTotalUnread();

  // Replaces the old useTableVersion(['messages','media']) + useEffect([...,
  // dataVersion]) pairing (#63): useDbQuery(#60) does the same synchronous
  // local read (a cheap COUNT — mirrors what loadChatCache itself does inside
  // chat/store.ts) and its return value changes whenever a local write OR a
  // background sync pull touches messages/media, so it doubles as the effect
  // trigger below without this component managing its own version plumbing.
  const unreadVersion = useDbQuery(
    () => (userId ? totalUnread(userId) : 0),
    [userId],
    ['messages', 'media'],
  );

  useEffect(() => {
    loadChatCache(userId);
    const interval = setInterval(() => loadChatCache(userId), 4000);
    return () => clearInterval(interval);
  }, [userId, unreadVersion]);

  const badge = count > 99 ? '99+' : String(count);

  return (
    <TouchableOpacity
      style={styles.wrap}
      onPress={() => router.push(CHAT_ROUTE)}
      accessibilityLabel={count > 0 ? `Messages, ${count} unread` : 'Messages'}
      hitSlop={8}
    >
      <Text style={styles.icon}>💬</Text>
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
  icon: { fontSize: 18 },
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
