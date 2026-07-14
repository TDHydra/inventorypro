import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  getMessages, sendMessage, getConversation, getParticipants, getMyParticipant,
  conversationTitle, markConversationRead, setNotifyPref, addParticipant,
  removeParticipant, leaveConversation,
  type MessageRow, type ParticipantRow, type NotifyPref, type MessageUrgency,
} from '../../../src/db/queries/chat';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { loadChatCache } from '../../../src/chat/store';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { syncNow } from '../../../src/sync/engine';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { useSession } from '../../../src/hooks/useSession';
import { useRouter } from 'expo-router';

const NOTIFY_PREFS: { key: NotifyPref; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'urgent', label: 'Urgent only' },
  { key: 'muted', label: 'Muted' },
];

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function ChatThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = String(id);
  const { user } = useSession();
  const userId = user?.id ?? null;
  const router = useRouter();
  const dataVersion = useDataVersion();
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => {
    setReloadKey(k => k + 1);
    loadChatCache(userId);
  }, [userId]);

  const conversation = useMemo(() => getConversation(conversationId), [conversationId, reloadKey, dataVersion]);
  const participants = useMemo(() => getParticipants(conversationId), [conversationId, reloadKey, dataVersion]);
  const myPart = useMemo(
    () => (userId ? getMyParticipant(conversationId, userId) : undefined),
    [conversationId, userId, reloadKey, dataVersion],
  );
  const messages = useMemo(() => getMessages(conversationId), [conversationId, reloadKey, dataVersion]);
  // Inverted list renders data[0] at the bottom → newest first in the array.
  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  const title = useMemo(
    () => (conversation ? conversationTitle(conversation, participants, userId ?? '') : 'Chat'),
    [conversation, participants, userId],
  );

  // Mark read on open + whenever new messages arrive.
  useEffect(() => {
    if (userId) { markConversationRead(conversationId, userId); loadChatCache(userId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, userId, messages.length]);

  const [draft, setDraft] = useState('');
  const [urgency, setUrgency] = useState<MessageUrgency>('urgent');

  const send = useCallback(() => {
    const body = draft.trim();
    if (!body || !userId) return;
    sendMessage(conversationId, userId, body, urgency);
    setDraft('');
    reload();
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
  }, [draft, userId, conversationId, urgency, reload]);

  // ── manage sheet (notify pref + group membership) ──────────────────────────
  const [managing, setManaging] = useState(false);
  const isGroup = conversation?.kind === 'group';

  const addable = useMemo((): PickerOption[] => {
    const present = new Set(participants.map(p => p.user_id));
    return getAllActiveUsers()
      .filter(u => !present.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role }));
  }, [participants]);

  const changePref = useCallback((pref: NotifyPref) => {
    if (!userId) return;
    setNotifyPref(conversationId, userId, pref);
    reload();
    void syncNow().catch(() => {});
  }, [userId, conversationId, reload]);

  const onAdd = useCallback((opt: PickerOption) => {
    addParticipant(conversationId, opt.id);
    reload();
    void syncNow().catch(() => {});
  }, [conversationId, reload]);

  const onRemove = useCallback((uid: string) => {
    removeParticipant(conversationId, uid);
    reload();
    void syncNow().catch(() => {});
  }, [conversationId, reload]);

  const onLeave = useCallback(() => {
    if (!userId) return;
    leaveConversation(conversationId, userId);
    setManaging(false);
    void syncNow().catch(() => {});
    router.back();
  }, [userId, conversationId, router]);

  const renderMessage = useCallback(({ item }: { item: MessageRow }) => {
    const mine = item.sender_id === userId;
    return (
      <View style={[s.msgRow, mine ? s.msgRowMine : s.msgRowTheirs]}>
        <View style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}>
          {isGroup && !mine && item.sender_name ? (
            <Text style={s.sender}>{item.sender_name}</Text>
          ) : null}
          <Text style={[s.msgText, mine && s.msgTextMine]}>{item.body}</Text>
          <View style={s.metaRow}>
            {item.urgency === 'urgent' && <Text style={[s.urgentTag, mine && s.urgentTagMine]}>URGENT</Text>}
            <Text style={[s.msgTime, mine && s.msgTimeMine]}>{timeLabel(item.created_at)}</Text>
          </View>
        </View>
      </View>
    );
  }, [userId, isGroup]);

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerShown: true,
          headerRight: () => (
            <TouchableOpacity onPress={() => setManaging(true)} hitSlop={8} style={s.hdrBtn}>
              <Text style={s.hdrBtnText}>Details</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        <FlatList
          data={inverted}
          keyExtractor={m => m.id}
          renderItem={renderMessage}
          inverted={inverted.length > 0}
          contentContainerStyle={s.list}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>No messages yet. Say hello 👋</Text>
            </View>
          }
        />

        <View style={s.composer}>
          <View style={s.urgencyRow}>
            {(['urgent', 'regular'] as MessageUrgency[]).map(u => (
              <TouchableOpacity
                key={u}
                style={[s.uToggle, urgency === u && s.uToggleOn]}
                onPress={() => setUrgency(u)}
              >
                <Text style={[s.uToggleText, urgency === u && s.uToggleTextOn]}>
                  {u === 'urgent' ? 'Urgent' : 'Regular'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.inputRow}>
            <TextInput
              style={s.input}
              placeholder="Message…"
              placeholderTextColor={colors.textMuted}
              value={draft}
              onChangeText={setDraft}
              multiline
            />
            <TouchableOpacity
              style={[s.sendBtn, !draft.trim() && s.sendBtnOff]}
              onPress={send}
              disabled={!draft.trim()}
            >
              <Text style={s.sendText}>Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      <ModalSheet visible={managing} onClose={() => setManaging(false)} scroll>
        <Text style={s.sheetTitle}>{title}</Text>

        <Text style={s.sectionLabel}>Notifications</Text>
        <View style={s.prefRow}>
          {NOTIFY_PREFS.map(p => {
            const on = (myPart?.notify_pref ?? 'all') === p.key;
            return (
              <TouchableOpacity
                key={p.key}
                style={[s.prefBtn, on && s.prefBtnOn]}
                onPress={() => changePref(p.key)}
              >
                <Text style={[s.prefText, on && s.prefTextOn]}>{p.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={s.sectionLabel}>Members ({participants.length})</Text>
        {participants.map((p: ParticipantRow) => (
          <View key={p.user_id} style={s.memberRow}>
            <Text style={s.memberName}>
              {p.name ?? p.user_id}{p.user_id === userId ? ' (you)' : ''}
            </Text>
            {isGroup && p.user_id !== userId && (
              <TouchableOpacity onPress={() => onRemove(p.user_id)} hitSlop={8}>
                <Text style={s.removeText}>Remove</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        {isGroup && (
          <View style={s.addField}>
            <SearchablePicker
              placeholder="Add someone…"
              options={addable}
              value={null}
              onSelect={onAdd}
            />
          </View>
        )}

        <View style={s.sheetActions}>
          <PrimaryButton label="Leave conversation" tone="danger" onPress={onLeave} />
        </View>
      </ModalSheet>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.md, gap: 6, flexGrow: 1 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyText: { color: colors.textMuted, fontSize: fontSizes.body },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgRowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: radii.lg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderBottomLeftRadius: 4 },
  sender: { fontSize: fontSizes.xs, fontWeight: '800', color: colors.primaryText, marginBottom: 2 },
  msgText: { fontSize: fontSizes.body, color: colors.textPrimary },
  msgTextMine: { color: '#fff' },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 2 },
  urgentTag: { fontSize: fontSizes.xs, fontWeight: '800', color: colors.accent },
  urgentTagMine: { color: '#FFE0C2' },
  msgTime: { fontSize: fontSizes.xs, color: colors.textMuted },
  msgTimeMine: { color: 'rgba(255,255,255,0.8)' },
  composer: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface, padding: spacing.sm, gap: spacing.sm },
  urgencyRow: { flexDirection: 'row', gap: spacing.sm },
  uToggle: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border },
  uToggleOn: { backgroundColor: colors.accentBg, borderColor: colors.accent },
  uToggleText: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary },
  uToggleTextOn: { color: colors.accent },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1, backgroundColor: colors.background, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, paddingTop: 10, paddingBottom: 10, maxHeight: 120,
    fontSize: fontSizes.body, color: colors.textPrimary,
  },
  sendBtn: { backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { opacity: 0.5 },
  sendText: { color: '#fff', fontWeight: '800', fontSize: fontSizes.body },
  sheetTitle: { fontSize: fontSizes.lg, fontWeight: '800', color: colors.textPrimary },
  sectionLabel: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginTop: spacing.lg, marginBottom: spacing.sm },
  prefRow: { flexDirection: 'row', gap: spacing.sm },
  prefBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border },
  prefBtnOn: { backgroundColor: colors.primaryBg, borderColor: colors.primary },
  prefText: { fontSize: fontSizes.body2, fontWeight: '700', color: colors.textSecondary },
  prefTextOn: { color: colors.primaryText },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.borderDetail },
  memberName: { fontSize: fontSizes.body, color: colors.textPrimary },
  removeText: { fontSize: fontSizes.body2, color: colors.danger, fontWeight: '700' },
  addField: { marginTop: spacing.md },
  sheetActions: { marginTop: spacing.xl },
  hdrBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  hdrBtnText: { color: '#fff', fontSize: fontSizes.body2, fontWeight: '700' },
});
