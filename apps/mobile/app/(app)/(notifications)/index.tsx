import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import {
  listNotifications, markRead, markAllRead, countUnread, NotificationRow,
  getApprovalRequestById, decideApproval,
} from '../../../src/db/queries/notifications';
import { colors } from '../../../src/theme';
import { Card } from '../../../src/components/ui/Card';
import { AppInput } from '../../../src/components/ui/AppInput';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { syncNow } from '../../../src/sync/engine';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { useSession } from '../../../src/hooks/useSession';

// Compact relative age from an ISO timestamp (mirrors the repairs list helper).
function ageLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// A fixed, non-PII glyph per notification type (falls back to a bell).
const TYPE_ICON: Record<string, string> = {
  broadcast: '📢',
  assignment: '📋',
  low_stock: '⚠️',
  checkout_idle: '✅',
  approval_request: '📝',
  approval_decision: '✅',
};

function iconFor(type: string): string {
  return TYPE_ICON[type] ?? '🔔';
}

function parseData(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Inline approve/reject actions for an `approval_request` notification. Joins
// the linked approval_requests row via data.id and only renders while that row
// is still `status === 'open'` — once decided (locally or via sync) the buttons
// disappear. Deciding writes the local UPDATE + outbox (decideApproval) and
// bumps the parent so the row re-renders / re-syncs.
function ApprovalActions({
  notification,
  userId,
  onDecided,
}: {
  notification: NotificationRow;
  userId: string | null;
  onDecided: () => void;
}) {
  const data = parseData(notification.data);
  const approvalId = typeof data?.id === 'string' ? data.id : undefined;
  const approval = approvalId ? getApprovalRequestById(approvalId) : undefined;
  const [note, setNote] = useState('');

  // No linked row (not yet synced) or already decided → nothing actionable.
  if (!approvalId || !approval || approval.status !== 'open') return null;

  const decide = (status: 'approved' | 'rejected') => {
    if (!userId) return;
    decideApproval(approvalId, status, userId, note.trim() || null);
    onDecided();
  };

  return (
    <View style={s.approvalBox}>
      <AppInput
        style={s.approvalNote}
        placeholder="Note (optional)"
        value={note}
        onChangeText={setNote}
      />
      <View style={s.approvalRow}>
        <TouchableOpacity
          style={[s.apprBtn, s.rejectBtn]}
          onPress={() => decide('rejected')}
        >
          <Text style={s.rejectText}>Reject</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.apprBtn, s.approveBtn]}
          onPress={() => decide('approved')}
        >
          <Text style={s.approveText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const { user } = useSession();
  const [reloadKey, setReloadKey] = useState(0);
  const reloadLocalData = useCallback(() => setReloadKey(k => k + 1), []);
  const dataVersion = useDataVersion();

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    reloadLocalData();
    setRefreshing(false);
  }, [refreshing, reloadLocalData]);

  // Recompute on reloadKey (local mark-read) and dataVersion (a sync pull
  // applied new rows) so the list stays live without a manual refresh.
  const rows = useMemo(
    (): NotificationRow[] => listNotifications(),
    [reloadKey, dataVersion],
  );
  const unread = useMemo(
    (): number => countUnread(),
    [reloadKey, dataVersion],
  );

  // Deep-link a tapped notification to its target screen when the payload names
  // a known one; broadcasts/approvals carry screen:'notifications' and stay put.
  const navigateTo = useCallback((data: Record<string, unknown> | undefined) => {
    const screen = typeof data?.screen === 'string' ? data.screen : undefined;
    const id = typeof data?.id === 'string' ? data.id : undefined;
    switch (screen) {
      case 'repairs':
        if (id) router.push({ pathname: '/(app)/(repairs)/[id]', params: { id } });
        return;
      case 'inventory':
        if (id) router.push({ pathname: '/(app)/(inventory)/[id]', params: { id } });
        return;
      case 'jobs':
        if (id) router.push({ pathname: '/(app)/(jobs)/[id]', params: { id } });
        return;
      default:
        /* 'notifications' / unknown → stay on the inbox */
        return;
    }
  }, [router]);

  const onPressItem = useCallback((item: NotificationRow) => {
    markRead(item.id);
    reloadLocalData();
    navigateTo(parseData(item.data));
  }, [navigateTo, reloadLocalData]);

  const onMarkAll = useCallback(() => {
    markAllRead();
    reloadLocalData();
  }, [reloadLocalData]);

  // After an inline approve/reject: refresh the list locally and push the
  // decision so the requester's inbox resolves promptly (offline-safe).
  const onDecided = useCallback(() => {
    reloadLocalData();
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
  }, [reloadLocalData]);

  return (
    <>
      <Stack.Screen options={{ title: 'Notifications', headerShown: true }} />
      <View style={s.container}>
        <FlatList
          data={rows}
          keyExtractor={n => n.id}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListHeaderComponent={
            unread > 0 ? (
              <View style={s.headerBar}>
                <Text style={s.headerCount}>{unread} unread</Text>
                <TouchableOpacity onPress={onMarkAll} hitSlop={8}>
                  <Text style={s.markAll}>Mark all read</Text>
                </TouchableOpacity>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const isUnread = item.read_at == null;
            return (
              <TouchableOpacity onPress={() => onPressItem(item)} activeOpacity={0.8}>
                <Card variant="list" style={isUnread ? s.cardUnread : undefined}>
                  <View style={s.row}>
                    <Text style={s.icon}>{iconFor(item.type)}</Text>
                    <View style={s.body}>
                      <View style={s.titleRow}>
                        {isUnread && <View style={s.dot} />}
                        <Text
                          style={[s.title, isUnread && s.titleUnread]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <Text style={s.age}>{ageLabel(item.created_at)}</Text>
                      </View>
                      {item.body ? (
                        <Text style={s.text} numberOfLines={3}>{item.body}</Text>
                      ) : null}
                      {item.type === 'approval_request' && (
                        <ApprovalActions
                          notification={item}
                          userId={user?.id ?? null}
                          onDecided={onDecided}
                        />
                      )}
                    </View>
                  </View>
                </Card>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              title="No notifications"
              subtitle="You're all caught up — new alerts will show up here."
            />
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { padding: 12, gap: 8, paddingBottom: 80 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, paddingBottom: 4,
  },
  headerCount: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  markAll: { fontSize: 13, color: colors.primary, fontWeight: '700' },
  cardUnread: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  row: { flexDirection: 'row', gap: 10 },
  icon: { fontSize: 20, lineHeight: 24 },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  titleUnread: { fontWeight: '700' },
  age: { fontSize: 12, color: colors.textMuted },
  text: { fontSize: 13, color: colors.textSecondary },
  approvalBox: { marginTop: 8, gap: 8 },
  approvalNote: { height: 38, paddingVertical: 8 },
  approvalRow: { flexDirection: 'row', gap: 8 },
  apprBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  approveBtn: { backgroundColor: colors.primary },
  approveText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rejectBtn: { backgroundColor: colors.dangerBg },
  rejectText: { color: '#991B1B', fontSize: 13, fontWeight: '700' },
});
