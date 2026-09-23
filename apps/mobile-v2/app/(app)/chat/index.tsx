// Station D1: ported from apps/mobile/app/(app)/(chat)/index.tsx (flat route
// here, matching every other mobile-v2 domain — no nested (chat) group / no
// separate _layout.tsx; ChatBell/header live in the shared app/(app)/_layout.tsx
// like every other screen).
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/chat' → '../../../src/repos/chat'
//   '../../../src/db/queries/users' → '../../../src/repos/users'
//   '../../../src/chat/store' (loadChatCache) → dropped; useDbQuery already
//     re-renders on every repo write (createRepository's insert/update/remove
//     all call appendOutbox, which bumps the touched table's version) and the
//     ChatBell badge is its own separate cache (src/chat/unread.ts) that
//     doesn't need this screen to touch it at all.
//   ui/* (Card/AppInput/EmptyState/ModalSheet/PrimaryButton) → '@invenpro/ui'
//   '../../../src/sync/engine' (syncNow) → '@invenpro/core'
//   '../../../src/hooks/useDataVersion' → dropped (useDbQuery covers it)
import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  useTheme, useThemedStyles, Card, AppInput, EmptyState, ModalSheet, PrimaryButton,
} from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';
import {
  listConversations, createDmConversation, createGroupConversation,
  type ConversationListItem,
} from '../../../src/repos/chat';
import { getAllActiveUsers } from '../../../src/repos/users';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { useSession } from '../../../src/hooks/useSession';

const CHAT_TABLES = ['conversations', 'conversation_participants', 'messages', 'users'];

// Compact relative age from an ISO timestamp (mirrors the notifications helper).
function ageLabel(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function titleFor(c: ConversationListItem): string {
  if (c.kind === 'group') return c.title?.trim() || 'Group';
  return c.peer_name?.trim() || 'Direct message';
}

export default function ChatListScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  // Edge-to-edge: this FAB is position:absolute/bottom:24 (fixed), so the
  // transparent gesture/3-button nav bar can overlay it without this inset
  // (same class of bug as BulkActionBar / ScanReceipt, #163).
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;

  const rows = useDbQuery(
    (): ConversationListItem[] => (userId ? listConversations(userId) : []),
    [userId],
    CHAT_TABLES,
  );

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local rows still render */ }
    setRefreshing(false);
  }, [refreshing]);

  // ── new-conversation flow ──────────────────────────────────────────────────
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<PickerOption[]>([]);
  const [groupTitle, setGroupTitle] = useState('');

  const userOptions = useDbQuery((): PickerOption[] => {
    if (!userId) return [];
    const chosen = new Set(selected.map(sel => sel.id));
    return getAllActiveUsers()
      .filter(u => u.id !== userId && !chosen.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role }));
  }, [userId, selected], ['users']);

  const openCompose = useCallback(() => {
    setSelected([]);
    setGroupTitle('');
    setComposing(true);
  }, []);

  const addSelected = useCallback((opt: PickerOption) => {
    setSelected(prev => (prev.some(p => p.id === opt.id) ? prev : [...prev, opt]));
  }, []);
  const removeSelected = useCallback((id: string) => {
    setSelected(prev => prev.filter(p => p.id !== id));
  }, []);

  const isGroup = selected.length >= 2;
  const canCreate = selected.length >= 1 && (!isGroup || groupTitle.trim().length > 0);

  const create = useCallback(() => {
    if (!userId || !canCreate) return;
    const convId = isGroup
      ? createGroupConversation(userId, groupTitle.trim(), selected.map(sel => sel.id))
      : createDmConversation(userId, selected[0].id);
    setComposing(false);
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({ pathname: '/(app)/chat/[id]', params: { id: convId } });
  }, [userId, canCreate, isGroup, groupTitle, selected, router]);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Messages',
          headerShown: true,
          headerRight: () => (
            <TouchableOpacity onPress={openCompose} hitSlop={8} style={s.newBtn}>
              <Text style={s.newBtnText}>+ New</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <View style={s.container}>
        <FlatList
          data={rows}
          keyExtractor={c => c.id}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
            />
          }
          renderItem={({ item }) => {
            const unread = item.unread > 0;
            return (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => router.push({ pathname: '/(app)/chat/[id]', params: { id: item.id } })}
              >
                <Card variant="list" style={unread ? s.cardUnread : undefined}>
                  <View style={s.row}>
                    <Text style={s.avatar}>{item.kind === 'group' ? '👥' : '💬'}</Text>
                    <View style={s.body}>
                      <View style={s.titleRow}>
                        <Text style={[s.title, unread && s.titleUnread]} numberOfLines={1}>
                          {titleFor(item)}
                        </Text>
                        <Text style={s.age}>{ageLabel(item.last_at)}</Text>
                      </View>
                      <View style={s.previewRow}>
                        <Text style={s.preview} numberOfLines={1}>
                          {item.last_body ?? 'No messages yet'}
                        </Text>
                        {unread && (
                          <View style={s.badge}>
                            <Text style={s.badgeText}>{item.unread}</Text>
                          </View>
                        )}
                        {item.notify_pref === 'muted' && <Text style={s.muted}>🔕</Text>}
                      </View>
                    </View>
                  </View>
                </Card>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              title="No conversations"
              subtitle="Tap + New to start a direct message or a group."
            />
          }
        />
        {/* FAB — same compose flow as the header "+ New", but always visible */}
        <TouchableOpacity
          style={[s.fab, { bottom: 24 + insets.bottom }]}
          onPress={openCompose}
          accessibilityLabel="New conversation"
          activeOpacity={0.85}
        >
          <Text style={s.fabText}>+</Text>
        </TouchableOpacity>
      </View>

      <ModalSheet visible={composing} onClose={() => setComposing(false)} scroll>
        <Text style={s.sheetTitle}>New conversation</Text>
        <Text style={s.sheetHint}>Pick one person for a direct message, or several for a group.</Text>

        {selected.length > 0 && (
          <View style={s.chips}>
            {selected.map(sel => (
              <TouchableOpacity key={sel.id} style={s.chip} onPress={() => removeSelected(sel.id)}>
                <Text style={s.chipText}>{sel.label} ✕</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <SearchablePicker
          placeholder="Add people…"
          options={userOptions}
          value={null}
          onSelect={addSelected}
        />

        {isGroup && (
          <View style={s.titleField}>
            <AppInput
              placeholder="Group name"
              value={groupTitle}
              onChangeText={setGroupTitle}
            />
          </View>
        )}

        <View style={s.sheetActions}>
          <PrimaryButton
            label={isGroup ? 'Create group' : 'Start chat'}
            onPress={create}
            disabled={!canCreate}
          />
        </View>
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  list: { padding: t.spacing.md, gap: t.spacing.sm, paddingBottom: 80 },
  newBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  newBtnText: { color: t.colors.headerTint, fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  fab: {
    position: 'absolute', right: 20, bottom: 24,
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: t.colors.primary, alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  fabText: { color: t.colors.onPrimary, fontSize: 30, fontWeight: '700', lineHeight: 34 },
  cardUnread: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  row: { flexDirection: 'row', gap: t.spacing.md, alignItems: 'center' },
  avatar: { fontSize: 22 },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  title: { flex: 1, fontSize: t.typography.fontSizes.md, fontWeight: '600', color: t.colors.textPrimary },
  titleUnread: { fontWeight: '800' },
  age: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  preview: { flex: 1, fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary },
  badge: {
    minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.colors.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  badgeText: { color: t.colors.onPrimary, fontSize: t.typography.fontSizes.xs, fontWeight: '800' },
  muted: { fontSize: t.typography.fontSizes.body2 },
  sheetTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '800', color: t.colors.textPrimary },
  sheetHint: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 4, marginBottom: t.spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm, marginBottom: t.spacing.md },
  chip: { backgroundColor: t.colors.primaryBgStrong, borderRadius: t.radii.md, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: t.colors.primaryText, fontSize: t.typography.fontSizes.body2, fontWeight: '700' },
  titleField: { marginTop: t.spacing.md },
  sheetActions: { marginTop: t.spacing.lg },
});
