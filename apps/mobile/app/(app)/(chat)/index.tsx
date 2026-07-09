import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import {
  listConversations, createDmConversation, createGroupConversation,
  type ConversationListItem,
} from '../../../src/db/queries/chat';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { loadChatCache } from '../../../src/chat/store';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { Card } from '../../../src/components/ui/Card';
import { AppInput } from '../../../src/components/ui/AppInput';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { syncNow } from '../../../src/sync/engine';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { useSession } from '../../../src/hooks/useSession';

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
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    setReloadKey(k => k + 1);
    loadChatCache(userId);
  }, [userId]);
  const dataVersion = useDataVersion();

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    reload();
    setRefreshing(false);
  }, [refreshing, reload]);

  const rows = useMemo(
    (): ConversationListItem[] => (userId ? listConversations(userId) : []),
    [userId, reloadKey, dataVersion],
  );

  // ── new-conversation flow ──────────────────────────────────────────────────
  const [composing, setComposing] = useState(false);
  const [selected, setSelected] = useState<PickerOption[]>([]);
  const [groupTitle, setGroupTitle] = useState('');

  const userOptions = useMemo((): PickerOption[] => {
    if (!userId) return [];
    const chosen = new Set(selected.map(s => s.id));
    return getAllActiveUsers()
      .filter(u => u.id !== userId && !chosen.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role }));
  }, [userId, selected]);

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
    let convId: string;
    if (isGroup) {
      convId = createGroupConversation(userId, groupTitle.trim(), selected.map(s => s.id));
    } else {
      convId = createDmConversation(userId, selected[0].id);
    }
    setComposing(false);
    reload();
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({ pathname: '/(app)/(chat)/[id]', params: { id: convId } });
  }, [userId, canCreate, isGroup, groupTitle, selected, reload, router]);

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
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => {
            const unread = item.unread > 0;
            return (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => router.push({ pathname: '/(app)/(chat)/[id]', params: { id: item.id } })}
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
      </View>

      <ModalSheet visible={composing} onClose={() => setComposing(false)} scroll>
        <Text style={s.sheetTitle}>New conversation</Text>
        <Text style={s.sheetHint}>Pick one person for a direct message, or several for a group.</Text>

        {selected.length > 0 && (
          <View style={s.chips}>
            {selected.map(sOpt => (
              <TouchableOpacity key={sOpt.id} style={s.chip} onPress={() => removeSelected(sOpt.id)}>
                <Text style={s.chipText}>{sOpt.label} ✕</Text>
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

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: 80 },
  newBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  newBtnText: { color: '#fff', fontSize: fontSizes.body, fontWeight: '700' },
  cardUnread: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  avatar: { fontSize: 22 },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, fontSize: fontSizes.md, fontWeight: '600', color: colors.textPrimary },
  titleUnread: { fontWeight: '800' },
  age: { fontSize: fontSizes.caption, color: colors.textMuted },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  preview: { flex: 1, fontSize: fontSizes.body2, color: colors.textSecondary },
  badge: {
    minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: fontSizes.xs, fontWeight: '800' },
  muted: { fontSize: fontSizes.body2 },
  sheetTitle: { fontSize: fontSizes.lg, fontWeight: '800', color: colors.textPrimary },
  sheetHint: { fontSize: fontSizes.body2, color: colors.textSecondary, marginTop: 4, marginBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: { backgroundColor: colors.primaryBgStrong, borderRadius: radii.md, paddingHorizontal: 10, paddingVertical: 6 },
  chipText: { color: colors.primaryText, fontSize: fontSizes.body2, fontWeight: '700' },
  titleField: { marginTop: spacing.md },
  sheetActions: { marginTop: spacing.lg },
});
