import { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { AppInput } from './ui/AppInput';
import { FieldLabel } from './ui/FieldLabel';
import { useSession } from '../hooks/useSession';
import { createApprovalRequest } from '../db/queries/notifications';
import { isWriteBlocked } from '../db/maintenance';
import { syncNow } from '../sync/engine';

interface Props {
  visible: boolean;
  /** Called on cancel or after a successful submit (parent hides the sheet). */
  onClose: () => void;
  /** Optional entity reference — prefilled when opened from a detail screen. */
  entityType?: string | null;
  entityId?: string | null;
  /** Human label for the referenced entity, shown as context in the sheet. */
  entityLabel?: string | null;
  /** Called only after a request was successfully created. */
  onSubmitted?: () => void;
}

/**
 * RequestApprovalSheet — manual "request approval" entry point.
 *
 * Collects a short title (what needs approval) + optional detail, then writes an
 * `open` approval_requests row via createApprovalRequest (local + outbox INSERT)
 * with the current user as requester. Fires a best-effort sync so approvers see
 * it promptly; the request is durable offline regardless. The server resolves
 * approvers and pushes them an inbox notification (Task 6).
 */
export function RequestApprovalSheet({
  visible,
  onClose,
  entityType,
  entityId,
  entityLabel,
  onSubmitted,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');

  function reset() {
    setTitle('');
    setDetail('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  function submit() {
    if (isWriteBlocked()) return;
    if (!user) {
      Alert.alert('Sign in required', 'You must be signed in to request approval.');
      return;
    }
    const t = title.trim();
    if (!t) {
      Alert.alert('Required', 'Describe what needs approval.');
      return;
    }
    try {
      createApprovalRequest({
        requesterId: user.id,
        kind: 'manual',
        title: t,
        detail: detail.trim() || null,
        entityType: entityType ?? null,
        entityId: entityId ?? null,
      });
    } catch (err) {
      Alert.alert(
        'Could not submit',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    // Best-effort push to the server so approvers are notified promptly; the
    // outbox entry survives offline and syncs on the next cycle regardless.
    void syncNow().catch(() => { /* offline — will sync later */ });
    reset();
    onSubmitted?.();
    onClose();
    Alert.alert('Approval requested', 'Your request was submitted for review.');
  }

  return (
    <ModalSheet visible={visible} onClose={handleClose}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
        <Text style={s.title}>Request Approval</Text>
        {entityLabel ? <Text style={s.sub}>For: {entityLabel}</Text> : null}

        <FieldLabel>What needs approval? *</FieldLabel>
        <AppInput
          placeholder="e.g. Write off damaged unit"
          value={title}
          onChangeText={setTitle}
          autoFocus
        />

        <FieldLabel>Details (optional)</FieldLabel>
        <AppInput
          style={s.multiline}
          placeholder="Add any context for the approver"
          value={detail}
          onChangeText={setDetail}
          multiline
        />

        <PrimaryButton label="Submit Request" onPress={submit} style={{ marginTop: 4 }} />
        <TouchableOpacity style={s.cancelBtn} onPress={handleClose}>
          <Text style={s.cancelText}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary },
  sub: { fontSize: 13, color: t.colors.textSecondary },
  multiline: { height: 90, paddingTop: 12, textAlignVertical: 'top' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelText: { color: t.colors.textMuted, fontSize: 15, fontWeight: '600' },
});
