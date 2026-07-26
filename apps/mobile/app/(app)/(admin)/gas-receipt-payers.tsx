import { useMemo, useState, useSyncExternalStore } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { TextField } from '../../../src/components/ui/TextField';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import {
  getGasReceiptPayers, setGasReceiptPayers, notifyGasReceiptPayersChanged,
  subscribeGasReceiptPayers, getGasReceiptPayersVersion,
} from '../../../src/db/gasReceiptPayers';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { isWriteBlocked } from '../../../src/db/maintenance';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// #168: who a gas receipt can be charged to. Synced via app_config (code
// default when absent — never migration-seeded). system_settings-gated like
// hidden-fields.tsx; every mutation logs + notifies subscribers so open
// receipt forms update live.
export default function GasReceiptPayersScreen() {
  const s = useThemedStyles(makeStyles);
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const version = useSyncExternalStore(subscribeGasReceiptPayers, getGasReceiptPayersVersion, getGasReceiptPayersVersion);
  const payers = useMemo(() => getGasReceiptPayers(), [version]);
  const [draft, setDraft] = useState('');
  // Non-null while renaming an existing entry (holds the original value).
  const [editing, setEditing] = useState<string | null>(null);

  function commit(next: string[], note: string) {
    if (isWriteBlocked()) return;
    try {
      runInTransaction(() => {
        setGasReceiptPayers(next);
        appendLog({
          action: 'gas_receipt_payers_changed',
          entity_type: 'app_config',
          entity_id: null, // UUID column — string keys here break the push
          user_id: user?.id ?? null,
          note,
          team_id: null, job_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, metadata: JSON.stringify({ payers: next }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not save payers', e instanceof Error ? e.message : 'Not saved. Try again.');
      return;
    }
    notifyGasReceiptPayersChanged();
    setDraft('');
    setEditing(null);
  }

  function onSave() {
    const value = draft.trim();
    if (!value) return;
    if (payers.includes(value) && value !== editing) {
      Alert.alert('Duplicate', `"${value}" is already in the list.`);
      return;
    }
    const next = editing
      ? payers.map(p => (p === editing ? value : p))
      : [...payers, value];
    commit(next, editing ? `renamed ${editing} → ${value}` : `added ${value}`);
  }

  function onRemove(p: string) {
    if (payers.length <= 1) {
      Alert.alert('At least one payer required', 'The receipt form requires a payer — keep at least one.');
      return;
    }
    commit(payers.filter(x => x !== p), `removed ${p}`);
  }

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Gas Receipt Payers', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to gas receipt payers.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Gas Receipt Payers', headerShown: true }} />
      <Text style={s.caption}>
        Who a gas receipt can be charged to. Applies to all users on all devices; existing
        receipts keep the name they were saved with.
      </Text>
      {payers.map(p => (
        <View key={p} style={s.row}>
          <Pressable style={s.rowMain} onPress={() => { setEditing(p); setDraft(p); }}>
            <Text style={s.rowLabel}>{p}{editing === p ? '  (editing…)' : ''}</Text>
          </Pressable>
          <Pressable onPress={() => onRemove(p)} hitSlop={8}>
            <Text style={s.remove}>✕</Text>
          </Pressable>
        </View>
      ))}
      <TextField
        label={editing ? `Rename "${editing}"` : 'Add payer'}
        value={draft}
        onChangeText={setDraft}
        placeholder="e.g. Warehouse"
      />
      <PrimaryButton label={editing ? 'Save Rename' : 'Add'} onPress={onSave} disabled={!draft.trim()} />
      {editing && (
        <PrimaryButton label="Cancel Rename" onPress={() => { setEditing(null); setDraft(''); }} />
      )}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, gap: t.spacing.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl },
  muted: { color: t.colors.textMuted },
  caption: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.colors.surface, borderRadius: t.radii.md,
    borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md,
  },
  rowMain: { flex: 1 },
  rowLabel: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  remove: { color: t.colors.danger, fontSize: t.typography.fontSizes.lg, paddingHorizontal: t.spacing.sm },
});
