import { useRouter } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { confirmSheet } from '../ui/ConfirmSheet';
import { createDmConversation } from '../../db/queries/chat';
import { clearSlot } from '../../db/queries/schedule';

interface Props {
  visible: boolean;
  onClose: () => void;
  manager: { id: string; name: string; email?: string | null; phone?: string | null };
  /** The schedule_assignments row backing this chip — "Clear this slot" clears THIS row, not the PM contact. */
  assignmentId: string;
}

// #184: read-only PM contact info for a tapped PRODUCTION MANAGER chip on the
// schedule board, with a one-tap DM handoff + editor-only clear.
export function PmContactPopup({ visible, onClose, manager, assignmentId }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('manage_schedule');

  function handleMessage() {
    if (!user?.id) return;
    const conversationId = createDmConversation(user.id, manager.id);
    onClose();
    router.push(`/(app)/(chat)/${conversationId}`);
  }

  async function handleClear() {
    const ok = await confirmSheet({
      title: 'Clear this slot?',
      message: 'The employee will no longer show as assigned to this manager at this time.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    clearSlot(assignmentId, user?.id ?? null);
    onClose();
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
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
