import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useChatUnread } from '../hooks/useChatUnread';

// Ported from apps/mobile/src/components/ChatBell.tsx, wired into
// app/(app)/_layout.tsx's headerRight next to NotificationBell (Station D1;
// that file's own comment named "chat bell" as a Wave C-D restoration).
//
// Simplified vs. the old app: the old ChatBell polled loadChatCache() every
// 4s because its hand-rolled chat store only refreshed on a table-version
// bump or that timer — a local mark-as-read didn't bump any table version so
// nothing else would have noticed it promptly. Here useChatUnread() reads
// src/chat/unread.ts's createConfigCache-backed cache, and every local
// mutation that changes MY OWN unread count calls reloadChatUnread()
// explicitly (chat/[id].tsx's mark-as-read effect) — the cache's subscriber
// set already includes every mounted ChatBell, so no polling is needed.
const CHAT_ROUTE = '/(app)/chat' as Href;

export function ChatBell() {
  const router = useRouter();
  const count = useChatUnread();
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
