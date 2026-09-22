// Ported from apps/mobile/app/(app)/(notifications)/index.tsx. Import mapping
// applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/notifications' (inbox half) → '../../../src/repos/notifications'
//   '../../../src/db/queries/notifications' (approvals half) → '../../../src/repos/approvals'
//     (already ported Station B3 — getApprovalRequestById/decideApproval are
//     NOT re-ported here, just re-imported from their existing home)
//   reloadKey/dataVersion manual refresh plumbing → '@invenpro/core''s
//     useDbQuery, reactive to local writes AND sync pulls on ['notifications']
//     (same idiom as approvals/index.tsx)
//   ui/* components, useTheme, useThemedStyles → '@invenpro/ui'
//   route '/(app)/(notifications)' → '/(app)/notifications' (plain dir)
//
// navigateTo() deep-link switch trimmed: the old screen could jump to
// repairs/inventory/jobs/media detail screens. Only inventory/[id] exists in
// mobile-v2 so far — the other three destinations aren't ported yet, so their
// cases are dropped (default: stay on the inbox, same as the old app's
// fallback for an unrecognized/'notifications' screen).
import { useState, useCallback, type ComponentProps } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, Card, AppInput, EmptyState } from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';
import {
  listNotifications, markRead, markAllRead, countUnread, type NotificationRow,
} from '../../../src/repos/notifications';
import { getApprovalRequestById, decideApproval } from '../../../src/repos/approvals';
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

// Module-level (stable identity) so the FlatList isn't re-created each render.
const renderKeyboardScroll = (props: ComponentProps<typeof KeyboardAwareScrollView>) => (
  <KeyboardAwareScrollView {...props} />
);

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
// disappear.
function ApprovalActions({
  notification,
  userId,
  onDecided,
}: {
  notification: NotificationRow;
  userId: string | null;
  onDecided: () => void;
}) {
  const s = useThemedStyles(makeStyles);
  const data = parseData(notification.data);
  const approvalId = typeof data?.id === 'string' ? data.id : undefined;
  const approval = useDbQuery(
    () => (approvalId ? getApprovalRequestById(approvalId) : undefined),
    [approvalId],
    ['approval_requests'],
  );
  const [note, setNote] = useState('');

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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user } = useSession();

  const rows = useDbQuery(() => listNotifications(), [], ['notifications']);
  const unread = useDbQuery(() => countUnread(), [], ['notifications']);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local list still reflects reality */ }
    setRefreshing(false);
  }, [refreshing]);

  // Deep-link a tapped notification to its target screen when the payload
  // names a known, ported one; broadcasts/approvals carry screen:'notifications'
  // and stay put. repairs/jobs/media aren't ported to mobile-v2 yet — cut.
  const navigateTo = useCallback((data: Record<string, unknown> | undefined) => {
    const screen = typeof data?.screen === 'string' ? data.screen : undefined;
    const id = typeof data?.id === 'string' ? data.id : undefined;
    if (screen === 'inventory' && id) {
      router.push({ pathname: '/(app)/inventory/[id]', params: { id } });
    }
    /* 'notifications' / unknown / not-yet-ported screens → stay on the inbox */
  }, [router]);

  const onPressItem = useCallback((item: NotificationRow) => {
    markRead(item.id);
    navigateTo(parseData(item.data));
  }, [navigateTo]);

  const onMarkAll = useCallback(() => {
    markAllRead();
  }, []);

  // After an inline approve/reject: push the decision so the requester's
  // inbox resolves promptly (offline-safe — outbox syncs later either way).
  const onDecided = useCallback(() => {
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: 'Notifications', headerShown: true }} />
      <View style={s.container}>
        <FlatList
          data={rows}
          keyExtractor={n => n.id}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={renderKeyboardScroll}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  list: { padding: 12, gap: 8, paddingBottom: 80 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, paddingBottom: 4,
  },
  headerCount: { fontSize: 13, color: t.colors.textMuted, fontWeight: '600' },
  markAll: { fontSize: 13, color: t.colors.primary, fontWeight: '700' },
  cardUnread: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  row: { flexDirection: 'row', gap: 10 },
  icon: { fontSize: 20, lineHeight: 24 },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: t.colors.primary },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  titleUnread: { fontWeight: '700' },
  age: { fontSize: 12, color: t.colors.textMuted },
  text: { fontSize: 13, color: t.colors.textSecondary },
  approvalBox: { marginTop: 8, gap: 8 },
  approvalNote: { height: 38, paddingVertical: 8 },
  approvalRow: { flexDirection: 'row', gap: 8 },
  apprBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  approveBtn: { backgroundColor: t.colors.primary },
  approveText: { color: t.colors.onPrimary, fontSize: 13, fontWeight: '700' },
  rejectBtn: { backgroundColor: t.colors.dangerBg },
  rejectText: { color: '#991B1B', fontSize: 13, fontWeight: '700' },
});
