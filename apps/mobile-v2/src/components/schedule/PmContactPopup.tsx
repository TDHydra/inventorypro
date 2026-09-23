import { View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, ModalSheet, PrimaryButton, FieldLabel, confirmSheet } from '@invenpro/ui';
import { useDbQuery, runInTransaction, syncNow } from '@invenpro/core';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { getUserById } from '../../repos/users';
import { appendLog } from '../../db/queries/log';
import { clearSlot } from '../../repos/schedule';
import { createDmConversation } from '../../repos/chat';
import { isWriteBlocked } from '../../db/maintenance';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The production_manager users.id backing this chip (schedule_assignments.manager_id). */
  managerId: string;
  /** The schedule_assignments row backing this chip — "Clear this slot" clears THIS row, not the PM contact. */
  assignmentId: string;
}

// Station C2: ported from apps/mobile/src/components/schedule/
// PmContactPopup.tsx. Import mapping: '../ui/*' -> '@invenpro/ui',
// '../../db/queries/users' -> '../../repos/users', '../../db/queries/schedule'
// -> '../../repos/schedule'.
//
// "Message" one-tap DM handoff restored Station D1 (src/repos/chat.ts).
//
// Behavior change (no-self-log convention): clearSlot() no longer logs
// 'schedule_cleared' itself (nor takes an actorId) — this handler now builds
// that log entry, wrapped in the SAME runInTransaction clearSlot already
// opens internally (reentrant -> one commit).
export function PmContactPopup({ visible, onClose, managerId, assignmentId }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('manage_schedule');
  const manager = useDbQuery(() => getUserById(managerId), [managerId], ['users']);

  function handleMessage() {
    if (!user?.id || !manager) return;
    // Same write-block guard as every other write affordance — a DM start is
    // a local conversations/participants INSERT like any other.
    if (isWriteBlocked()) return;
    const conversationId = createDmConversation(user.id, manager.id);
    onClose();
    void syncNow().catch(() => { /* offline — outbox syncs later */ });
    router.push({ pathname: '/(app)/chat/[id]', params: { id: conversationId } });
  }

  async function handleClear() {
    const ok = await confirmSheet({
      title: 'Clear this slot?',
      message: 'The employee will no longer show as assigned to this manager at this time.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    runInTransaction(() => {
      const cleared = clearSlot(assignmentId);
      if (!cleared) return; // already cleared (double-tap) — no-op, nothing to log
      appendLog({
        user_id: user?.id ?? null, team_id: null, action: 'schedule_cleared', entity_type: 'user',
        entity_id: cleared.employee_id, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: null, note: null,
        metadata: JSON.stringify({ assignment_id: cleared.id, day: cleared.day, reason: 'manual_clear' }),
        device_id: null,
      });
    });
    onClose();
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      {manager ? (
        <>
          <Text style={s.name}>{manager.name}</Text>
          <FieldLabel style={s.fieldLabel}>Email</FieldLabel>
          <Text style={s.value}>{manager.email || '—'}</Text>
          <FieldLabel style={s.fieldLabel}>Phone</FieldLabel>
          <Text style={s.value}>{manager.phone || '—'}</Text>
          <View style={s.actions}>
            <PrimaryButton label="Message" onPress={handleMessage} />
            {canEdit && (
              <PrimaryButton label="Clear this slot" tone="danger" onPress={handleClear} style={s.clearBtn} />
            )}
          </View>
        </>
      ) : (
        <Text style={s.value}>Manager not found.</Text>
      )}
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  name: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  fieldLabel: { marginTop: t.spacing.lg, marginBottom: t.spacing.xs },
  value: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  actions: { marginTop: t.spacing.xl, gap: t.spacing.md },
  clearBtn: { marginTop: t.spacing.sm },
});
