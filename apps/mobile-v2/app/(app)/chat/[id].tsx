// Station D1: ported from apps/mobile/app/(app)/(chat)/[id].tsx (flat route,
// no nested (chat) group / _layout.tsx — matches every other mobile-v2 domain).
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/chat' → '../../../src/repos/chat'
//   '../../../src/db/queries/users' → '../../../src/repos/users'
//   '../../../src/chat/store' (loadChatCache) → '../../../src/chat/unread'
//     (reloadChatUnread) — the createConfigCache-backed replacement (Station D1).
//   '../../../src/lib/themedAlert' (Alert), ui/* → '@invenpro/ui'
//   '../../../src/sync/engine' (syncNow), useDbQuery → '@invenpro/core'
//   '../../../src/chat/mentions', '../../../src/chat/composerInsets' → ported
//     verbatim alongside this screen (pure, no media dependency).
//
// Image attachments (the composer's 🖼️ button, expo-image-picker,
// uploadMediaAsset, getMessageMedia/inline <Image> rendering): cut at Station
// D1, restored Station D2 once src/media landed. Everything else (send/edit/
// delete text messages, @mentions, read receipts, notify prefs, group
// add/remove/leave) is a straight port.
//
// chatPolicy (../../../src/chat/chatPolicy.ts, new this station): the long-
// press action menu only offers Edit/Delete when canEditMessage/
// canDeleteMessage allow it (sender-only) rather than the old app's ad hoc
// `disabled={!mine}` on the bubble's TouchableOpacity — same rule, now backed
// by the client-side policy mirror the brief asked for.
import { useState, useMemo, useCallback, useEffect, type ComponentProps } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, StyleSheet,
  Image, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
// keyboard-controller's KeyboardAvoidingView (NOT react-native's): once
// <KeyboardProvider> is mounted app-wide (app/_layout.tsx), it takes over
// Android soft-input handling, so RN's KeyboardAvoidingView is a no-op there.
import { KeyboardChatScrollView, KeyboardStickyView } from 'react-native-keyboard-controller';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, Alert, ModalSheet, PrimaryButton } from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';
import {
  getMessages, getMessageMedia, sendMessage, editMessage, deleteMessage, getConversation,
  getParticipants, getMyParticipant, conversationTitle, markConversationRead,
  setNotifyPref, addParticipant, removeParticipant, leaveConversation,
  type Message, type Participant, type NotifyPref, type MessageUrgency,
} from '../../../src/repos/chat';
import { uploadMediaAsset } from '../../../src/media/upload';
import { canEditMessage, canDeleteMessage, canSendMessage } from '../../../src/chat/chatPolicy';
import { getAllActiveUsers } from '../../../src/repos/users';
import { reloadChatUnread } from '../../../src/chat/unread';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { parseMentions } from '../../../src/chat/mentions';
import { composerBottomPadding } from '../../../src/chat/composerInsets';
import { useSession } from '../../../src/hooks/useSession';
import { isWriteBlocked } from '../../../src/db/maintenance';

// Swap the message FlatList's scroll surface for keyboard-controller's chat
// scroll view so the newest (bottom) messages of the inverted list stay visible
// above the keyboard. Module-level (stable identity) so the FlatList isn't
// re-created each render.
const renderChatScroll = (props: ComponentProps<typeof KeyboardChatScrollView>) => (
  <KeyboardChatScrollView {...props} />
);

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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  // `draft`: an optional prefill from the "Discuss this" / "Request access"
  // entry points — a DM opened FOR the user with a starter message already
  // typed in. Named separately from the `draft` composer state below so the
  // param can't shadow it.
  const { id, draft: draftParam } = useLocalSearchParams<{ id: string; draft?: string }>();
  const conversationId = String(id);
  const { user } = useSession();
  const userId = user?.id ?? null;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Re-runs whenever a local write OR a background sync pull touches one of
  // these tables — no manual reload key needed for local-DB reads.
  const conversation = useDbQuery(() => getConversation(conversationId), [conversationId], ['conversations']);
  const participants = useDbQuery(() => getParticipants(conversationId), [conversationId], ['conversation_participants', 'users']);
  const myPart = useDbQuery(
    () => (userId ? getMyParticipant(conversationId, userId) : undefined),
    [conversationId, userId],
    ['conversation_participants'],
  );
  const messages = useDbQuery(() => getMessages(conversationId), [conversationId], ['messages', 'users']);
  // Image attachments (#29-H), keyed by message id — synced media rows.
  const mediaByMsg = useDbQuery(() => getMessageMedia(conversationId), [conversationId], ['media', 'messages']);
  // Inverted list renders data[0] at the bottom → newest first in the array.
  const inverted = useMemo(() => [...messages].reverse(), [messages]);

  const title = useMemo(
    () => (conversation ? conversationTitle(conversation, participants, userId ?? '') : 'Chat'),
    [conversation, participants, userId],
  );

  // Mark read on open + whenever new messages arrive. Guarded on the conversation
  // still existing locally — after a chat purge the participant row is gone and an
  // outbox UPDATE for it would be rejected server-side.
  const conversationExists = !!conversation;
  useEffect(() => {
    if (userId && conversationExists) {
      markConversationRead(conversationId, userId);
      reloadChatUnread();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, userId, conversationExists, messages.length]);

  const [draft, setDraft] = useState('');
  const [urgency, setUrgency] = useState<MessageUrgency>('urgent');

  // Prefill the composer from `draftParam` ONCE, and only if the composer is
  // still empty (never stomps something the user already started typing).
  // Does not auto-send.
  useEffect(() => {
    if (draftParam && draft === '') setDraft(draftParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftParam]);

  // ── edit / delete own messages ──────────────────────────────────────────────
  const [actionMsg, setActionMsg] = useState<Message | null>(null); // long-press menu target
  const [editingId, setEditingId] = useState<string | null>(null);
  const [prevDraft, setPrevDraft] = useState(''); // composer text stashed while editing

  const beginEdit = useCallback((m: Message) => {
    setActionMsg(null);
    setEditingId(m.id);
    setPrevDraft(draft);
    setDraft(m.body);
  }, [draft]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(prevDraft);
    setPrevDraft('');
  }, [prevDraft]);

  const onDelete = useCallback((m: Message) => {
    if (!userId || !canDeleteMessage(m.sender_id, userId)) return;
    setActionMsg(null);
    if (editingId === m.id) cancelEdit();
    if (isWriteBlocked()) return;
    deleteMessage(m.id);
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
  }, [userId, editingId, cancelEdit]);

  const send = useCallback(() => {
    const body = draft.trim();
    if (!body || !userId) return;
    if (isWriteBlocked()) return;
    if (editingId) {
      editMessage(editingId, body);
      setEditingId(null);
      setDraft(prevDraft);
      setPrevDraft('');
    } else {
      if (!canSendMessage(!!myPart)) return;
      // @mentions matched against the CURRENT conversation participants,
      // excluding the sender — mentioned participants bypass their
      // notify_pref server-side (mute included).
      const candidates = participants.map(p => ({ id: p.user_id, name: p.name ?? '' }));
      const mentioned = parseMentions(body, candidates, userId);
      sendMessage(conversationId, userId, body, urgency, mentioned);
      setDraft('');
    }
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
  }, [draft, userId, conversationId, urgency, editingId, prevDraft, participants, myPart]);

  // ── image attachments (#29-H) ───────────────────────────────────────────────
  // Pick an image → create the message row first (draft as optional caption) →
  // upload keyed to that message id (media entity_type='message'). Uploads need
  // connectivity (presigned PUT), unlike plain text sends. v2 deviation: the
  // send/write guards (canSendMessage + isWriteBlocked) match send() above;
  // no manual reload — useDbQuery on ['media','messages'] refreshes the list.
  const [attaching, setAttaching] = useState(false);

  const attachImage = useCallback(async () => {
    if (!userId) return;
    if (!canSendMessage(!!myPart)) return;
    if (isWriteBlocked()) return;
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow photo library access to send images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: false,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    // Server allows short alphanumeric extensions only; fall back to jpg.
    const rawExt = (asset.fileName?.split('.').pop() ?? asset.mimeType?.split('/').pop() ?? 'jpg').toLowerCase();
    const ext = /^[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : 'jpg';

    const caption = draft.trim();
    const msg = sendMessage(conversationId, userId, caption, urgency);
    setDraft('');
    setAttaching(true);
    try {
      // The presign route's participant gate looks the message up SERVER-side
      // (messages ⋈ conversation_participants), so the outbox row must be
      // pushed before we can ask for an upload URL — otherwise a guaranteed 403.
      await syncNow().catch(() => { /* upload below surfaces connectivity errors */ });
      await uploadMediaAsset({
        entityType: 'message', entityId: msg.id,
        mediaType: 'image', ext,
        uri: asset.uri, file: asset.file ?? undefined, size: asset.fileSize ?? undefined,
        userId,
      });
    } catch (err) {
      // A caption-less message has nothing left to say without its image —
      // soft-delete it; a captioned one stays as plain text.
      if (!caption) deleteMessage(msg.id);
      Alert.alert('Upload Failed', (err as Error).message);
    } finally {
      setAttaching(false);
      void syncNow().catch(() => { /* offline — outbox syncs later */ });
    }
  }, [userId, conversationId, draft, urgency, myPart]);

  // ── read receipts ────────────────────────────────────────────────────────────
  // Rendered under the caller's LATEST own (non-deleted) message only, from the
  // other participants' last_read_at (already synced rows — refreshes via the
  // useDbQuery reads above).
  const lastOwn = useMemo((): Message | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.sender_id === userId && !m.deleted_at) return m;
    }
    return undefined;
  }, [messages, userId]);

  const receipt = useMemo((): string | null => {
    if (!lastOwn) return null;
    const others = participants.filter(p => p.user_id !== userId);
    if (others.length === 0) return null;
    const sentAt = new Date(lastOwn.created_at).getTime();
    const readers = others.filter(
      p => p.last_read_at != null && new Date(p.last_read_at).getTime() >= sentAt,
    );
    if (conversation?.kind === 'group') {
      return readers.length > 0 ? `Read by ${readers.length} of ${others.length}` : null;
    }
    return readers.length === others.length ? 'Read' : null;
  }, [lastOwn, participants, userId, conversation?.kind]);

  // ── manage sheet (notify pref + group membership) ──────────────────────────
  const [managing, setManaging] = useState(false);
  const isGroup = conversation?.kind === 'group';

  const addable = useDbQuery((): PickerOption[] => {
    const present = new Set(participants.map(p => p.user_id));
    return getAllActiveUsers()
      .filter(u => !present.has(u.id))
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role }));
  }, [participants], ['users']);

  const changePref = useCallback((pref: NotifyPref) => {
    if (!userId || isWriteBlocked()) return;
    setNotifyPref(conversationId, userId, pref);
    void syncNow().catch(() => {});
  }, [userId, conversationId]);

  const onAdd = useCallback((opt: PickerOption) => {
    if (isWriteBlocked()) return;
    addParticipant(conversationId, opt.id);
    void syncNow().catch(() => {});
  }, [conversationId]);

  const onRemove = useCallback((uid: string) => {
    if (isWriteBlocked()) return;
    removeParticipant(conversationId, uid);
    void syncNow().catch(() => {});
  }, [conversationId]);

  const onLeave = useCallback(() => {
    if (!userId || isWriteBlocked()) return;
    leaveConversation(conversationId, userId);
    setManaging(false);
    reloadChatUnread();
    void syncNow().catch(() => {});
    router.back();
  }, [userId, conversationId, router]);

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const mine = item.sender_id === userId;
    if (item.deleted_at) {
      return (
        <View style={[s.msgRow, mine ? s.msgRowMine : s.msgRowTheirs]}>
          <View style={[s.bubble, s.bubbleDeleted]}>
            <Text style={s.deletedText}>Message deleted</Text>
          </View>
        </View>
      );
    }
    const canManage = userId != null && (canEditMessage(item.sender_id, userId) || canDeleteMessage(item.sender_id, userId));
    const images = mediaByMsg.get(item.id);
    return (
      <View>
        <View style={[s.msgRow, mine ? s.msgRowMine : s.msgRowTheirs]}>
          <TouchableOpacity
            activeOpacity={0.8}
            disabled={!canManage}
            onLongPress={() => setActionMsg(item)}
            style={[s.bubble, mine ? s.bubbleMine : s.bubbleTheirs]}
          >
            {isGroup && !mine && item.sender_name ? (
              <Text style={s.sender}>{item.sender_name}</Text>
            ) : null}
            {images?.map(url => (
              <Image key={url} source={{ uri: url }} style={s.msgImage} resizeMode="cover" />
            ))}
            {item.body ? <Text style={[s.msgText, mine && s.msgTextMine]}>{item.body}</Text> : null}
            <View style={s.metaRow}>
              {item.urgency === 'urgent' && <Text style={[s.urgentTag, mine && s.urgentTagMine]}>URGENT</Text>}
              {item.edited_at ? <Text style={[s.msgTime, mine && s.msgTimeMine]}>(edited)</Text> : null}
              <Text style={[s.msgTime, mine && s.msgTimeMine]}>{timeLabel(item.created_at)}</Text>
            </View>
          </TouchableOpacity>
        </View>
        {item.id === lastOwn?.id && receipt ? (
          <View style={s.receiptRow}>
            <Text style={s.receiptText}>{receipt}</Text>
          </View>
        ) : null}
      </View>
    );
  }, [userId, isGroup, lastOwn?.id, receipt, mediaByMsg, s]);

  // The conversation row disappeared while open (removed-member purge / deletion)
  // — render a graceful dead-end instead of an empty shell that can still write.
  if (!conversation) {
    return (
      <>
        <Stack.Screen options={{ title: 'Chat', headerShown: true }} />
        <View style={s.goneWrap}>
          <Text style={s.goneTitle}>This conversation is no longer available</Text>
          <Text style={s.goneSub}>You may have been removed from it, or it was deleted.</Text>
          <PrimaryButton label="Back to messages" onPress={() => router.back()} />
        </View>
      </>
    );
  }

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
      {/* keyboard-controller chat pattern: KeyboardChatScrollView keeps the
          newest (bottom) messages of the inverted list visible when the keyboard
          opens, and KeyboardStickyView pins the composer directly above it. */}
      <View style={s.container}>
        <FlatList
          style={s.flex}
          renderScrollComponent={renderChatScroll}
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

        {/* opened:insets.bottom folds out the composer's own bottom inset (which
            clears the nav bar when closed) so the input sits snug above the
            keyboard instead of leaving a gap. */}
        <KeyboardStickyView
          offset={{ opened: insets.bottom }}
          style={[s.composer, { paddingBottom: composerBottomPadding(t.spacing.sm, insets.bottom) }]}
        >
          {editingId ? (
            <View style={s.editingRow}>
              <Text style={s.editingText}>Editing message</Text>
              <TouchableOpacity onPress={cancelEdit} hitSlop={8}>
                <Text style={s.editingCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
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
          )}
          <View style={s.inputRow}>
            {!editingId && (
              <TouchableOpacity
                style={s.attachBtn}
                onPress={() => { void attachImage(); }}
                disabled={attaching}
                hitSlop={4}
              >
                {attaching
                  ? <ActivityIndicator size="small" color={t.colors.primary} />
                  : <Text style={s.attachIcon}>🖼️</Text>}
              </TouchableOpacity>
            )}
            <TextInput
              style={s.input}
              placeholder="Message…"
              placeholderTextColor={t.colors.textMuted}
              value={draft}
              onChangeText={setDraft}
              multiline
            />
            <TouchableOpacity
              style={[s.sendBtn, !draft.trim() && s.sendBtnOff]}
              onPress={send}
              disabled={!draft.trim()}
            >
              <Text style={s.sendText}>{editingId ? 'Save' : 'Send'}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardStickyView>
      </View>

      {/* Long-press action menu for messages the caller may edit/delete. */}
      <ModalSheet visible={!!actionMsg} onClose={() => setActionMsg(null)}>
        <Text style={s.sheetTitle}>Message</Text>
        {actionMsg && userId && canEditMessage(actionMsg.sender_id, userId) && (
          <TouchableOpacity
            style={s.msgActionRow}
            onPress={() => { if (actionMsg) beginEdit(actionMsg); }}
          >
            <Text style={s.msgActionText}>✏️ Edit</Text>
          </TouchableOpacity>
        )}
        {actionMsg && userId && canDeleteMessage(actionMsg.sender_id, userId) && (
          <TouchableOpacity
            style={s.msgActionRow}
            onPress={() => { if (actionMsg) onDelete(actionMsg); }}
          >
            <Text style={[s.msgActionText, s.msgActionDanger]}>🗑 Delete</Text>
          </TouchableOpacity>
        )}
      </ModalSheet>

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
        {participants.map((p: Participant) => (
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  flex: { flex: 1 },
  list: { padding: t.spacing.md, gap: 6, flexGrow: 1 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 },
  emptyText: { color: t.colors.textMuted, fontSize: t.typography.fontSizes.body },
  msgRow: { flexDirection: 'row', marginVertical: 2 },
  msgRowMine: { justifyContent: 'flex-end' },
  msgRowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: t.radii.lg, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm },
  bubbleMine: { backgroundColor: t.colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, borderBottomLeftRadius: 4 },
  sender: { fontSize: t.typography.fontSizes.xs, fontWeight: '800', color: t.colors.primaryText, marginBottom: 2 },
  msgImage: { width: 200, height: 200, borderRadius: t.radii.md, backgroundColor: t.colors.border, marginBottom: 4 },
  msgText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  msgTextMine: { color: t.colors.onPrimary },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 2 },
  urgentTag: { fontSize: t.typography.fontSizes.xs, fontWeight: '800', color: t.colors.accent },
  urgentTagMine: { color: '#FFE0C2' },
  msgTime: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
  msgTimeMine: { color: 'rgba(255,255,255,0.8)' },
  bubbleDeleted: { backgroundColor: t.colors.background, borderWidth: 1, borderColor: t.colors.borderDetail },
  deletedText: { fontSize: t.typography.fontSizes.body2, fontStyle: 'italic', color: t.colors.textMuted },
  receiptRow: { alignItems: 'flex-end', paddingRight: 4, marginTop: 2 },
  receiptText: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
  editingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editingText: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary },
  editingCancel: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.danger },
  msgActionRow: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  msgActionText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
  msgActionDanger: { color: t.colors.danger },
  goneWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl, gap: t.spacing.md, backgroundColor: t.colors.background },
  goneTitle: { fontSize: t.typography.fontSizes.md, fontWeight: '700', color: t.colors.textPrimary, textAlign: 'center' },
  goneSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, textAlign: 'center', marginBottom: t.spacing.md },
  composer: { borderTopWidth: 1, borderTopColor: t.colors.border, backgroundColor: t.colors.surface, padding: t.spacing.sm, gap: t.spacing.sm },
  urgencyRow: { flexDirection: 'row', gap: t.spacing.sm },
  uToggle: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.colors.border },
  uToggleOn: { backgroundColor: t.colors.accentBg, borderColor: t.colors.accent },
  uToggleText: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary },
  uToggleTextOn: { color: t.colors.accent },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.sm },
  attachBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  attachIcon: { fontSize: 22 },
  input: {
    flex: 1, backgroundColor: t.colors.background, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, paddingTop: 10, paddingBottom: 10, maxHeight: 120,
    fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
  },
  sendBtn: { backgroundColor: t.colors.primary, borderRadius: t.radii.md, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center' },
  sendBtnOff: { opacity: 0.5 },
  sendText: { color: t.colors.onPrimary, fontWeight: '800', fontSize: t.typography.fontSizes.body },
  sheetTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '800', color: t.colors.textPrimary },
  sectionLabel: { fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textMuted, textTransform: 'uppercase', marginTop: t.spacing.lg, marginBottom: t.spacing.sm },
  prefRow: { flexDirection: 'row', gap: t.spacing.sm },
  prefBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: t.radii.sm, borderWidth: 1, borderColor: t.colors.border },
  prefBtnOn: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primary },
  prefText: { fontSize: t.typography.fontSizes.body2, fontWeight: '700', color: t.colors.textSecondary },
  prefTextOn: { color: t.colors.primaryText },
  memberRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  memberName: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  removeText: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, fontWeight: '700' },
  addField: { marginTop: t.spacing.md },
  sheetActions: { marginTop: t.spacing.xl },
  hdrBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  hdrBtnText: { color: t.colors.headerTint, fontSize: t.typography.fontSizes.body2, fontWeight: '700' },
});
