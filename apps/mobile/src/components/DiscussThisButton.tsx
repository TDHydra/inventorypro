import { useMemo, useState, useCallback } from 'react';
import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { useSession } from '../hooks/useSession';
import { useDataVersion } from '../hooks/useDataVersion';
import { ModalSheet } from './ui/ModalSheet';
import { KIT_HIT_SLOP } from './ui/hitSlop';
import { SearchablePicker, type PickerOption } from './SearchablePicker';
import { getAllActiveUsers } from '../db/queries/users';
import { createDmConversation } from '../db/queries/chat';
import { isWriteBlocked } from '../db/maintenance';
import { syncNow } from '../sync/engine';
import { buildDiscussDraft, type DiscussKind } from '../chat/discussDraft';
import { track } from '../telemetry';

// #228: "Discuss this" — entity-linked chat entry for detail-screen headers.
// Opens a person picker (same active-user source as the chat compose sheet),
// starts/reuses a DM, and lands in the conversation with a prefilled draft
// referencing the entity via the #203 draft param in (chat)/[id].tsx.
// Shared component so jobs/repairs/equipment can't drift apart.

export function DiscussThisButton({ kind, label, refText }: {
  kind: DiscussKind;
  label: string;
  // Not `ref` — that prop name is reserved by React.
  refText?: string | null;
}) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [open, setOpen] = useState(false);
  const dataVersion = useDataVersion();

  const userOptions = useMemo((): PickerOption[] => {
    if (!open || !userId) return [];
    return getAllActiveUsers()
      .filter(u => u.id !== userId)
      .map(u => ({ id: u.id, label: u.name, sublabel: u.role }));
  }, [open, userId, dataVersion]);

  const draft = buildDiscussDraft({ kind, label, ref: refText ?? null });

  const pick = useCallback((opt: PickerOption) => {
    if (!userId) return;
    // #203: same write-block guard as every other write affordance — during
    // maintenance lock or "Preview as role" this silently no-ops.
    if (isWriteBlocked()) { setOpen(false); return; }
    const conversationId = createDmConversation(userId, opt.id);
    setOpen(false);
    track('action', 'discuss_this', { screen: kind });
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({
      pathname: '/(app)/(chat)/[id]',
      params: { id: conversationId, draft },
    });
  }, [userId, draft, kind, router]);

  if (!userId) return null;

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        hitSlop={KIT_HIT_SLOP}
        style={s.headerBtn}
        accessibilityRole="button"
        accessibilityLabel="Discuss in chat"
      >
        <Text style={s.headerBtnText}>💬</Text>
      </TouchableOpacity>

      <ModalSheet visible={open} onClose={() => setOpen(false)} scroll>
        <Text style={s.sheetTitle}>Discuss this</Text>
        <Text style={s.sheetHint} numberOfLines={2}>
          Pick who to message — the chat starts with “{draft.slice(0, -2)}”.
        </Text>
        <SearchablePicker
          placeholder="Message…"
          options={userOptions}
          value={null}
          onSelect={pick}
        />
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  headerBtn: { paddingHorizontal: 8, paddingVertical: 4, marginRight: 4 },
  headerBtnText: { fontSize: t.typography.fontSizes.md },
  sheetTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '800', color: t.colors.textPrimary },
  sheetHint: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 4, marginBottom: t.spacing.md },
});
