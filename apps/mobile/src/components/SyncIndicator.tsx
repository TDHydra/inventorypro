import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Alert } from '../lib/themedAlert';
import { getDb } from '../db/schema';
import { getOutboxCounts, getFailedOutbox, retryFailedOutbox, discardFailedOutbox, getDeniedOutbox, discardDeniedEntry, OutboxEntry } from '../sync/outbox';
import { syncNow } from '../sync/engine';
import { entityLabel } from '../sync/denialMessages';
import { useSession } from '../hooks/useSession';
import { pickAccessGrantor } from '../auth/pickAccessGrantor';
import { createDmConversation } from '../db/queries/chat';
import { isWriteBlocked } from '../db/maintenance';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';

type SyncStatus = 'synced' | 'pending' | 'failed' | 'denied' | 'offline';

export function SyncIndicator() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user } = useSession();
  const router = useRouter();
  // Edge-to-edge: this is a hand-rolled bottom sheet (justifyContent:'flex-end'),
  // so the transparent gesture/3-button nav bar overlays its Retry/Discard
  // buttons without this inset (same class of bug as ScanReceipt, #163).
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<SyncStatus>('synced');
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(0);
  const [firstError, setFirstError] = useState<string | null>(null);
  const [denied, setDenied] = useState<OutboxEntry[]>([]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showSheet, setShowSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const interval = setInterval(refresh, 5000);
    refresh();
    return () => clearInterval(interval);
  }, []);

  function refresh() {
    try {
      // active = still retrying; failed = retry-exhausted (the entries that used
      // to pin this indicator "pending" forever with no way to clear them).
      const { active: a, failed: f } = getOutboxCounts();
      setActive(a);
      setFailed(f);
      if (f > 0) {
        const first = getFailedOutbox(1)[0];
        setFirstError(first ? `${first.operation} ${first.table_name}: ${first.last_error ?? 'rejected'}` : null);
      } else {
        setFirstError(null);
      }

      // Denied (#202): permanently rejected by the server (an authorization
      // denial) — never retried, so they're listed separately with their
      // friendly message (last_error, set by markOutboxDenied) and a Dismiss
      // action instead of Retry.
      const deniedEntries = getDeniedOutbox();
      setDenied(deniedEntries);

      const settingResult = getDb().executeSync(
        `SELECT value FROM app_settings WHERE key = 'last_pulled_at'`
      );
      setLastSync((settingResult.rows[0] as { value: string } | undefined)?.value ?? null);

      setStatus(f > 0 ? 'failed' : deniedEntries.length > 0 ? 'denied' : a > 0 ? 'pending' : 'synced');
    } catch {
      setStatus('offline');
    }
  }

  async function handleRetry() {
    setBusy(true);
    try {
      const n = retryFailedOutbox();
      await syncNow();
      refresh();
      Alert.alert('Retrying', n > 0 ? `Re-queued ${n} failed change${n !== 1 ? 's' : ''}.` : 'Nothing to retry.');
    } catch {
      Alert.alert('Retry failed', 'Could not reach the server. It will keep trying.');
    } finally {
      setBusy(false);
    }
  }

  function handleDiscard() {
    Alert.alert(
      'Discard failed changes?',
      `Permanently drop ${failed} change${failed !== 1 ? 's' : ''} that could not be uploaded. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard', style: 'destructive',
          onPress: () => { discardFailedOutbox(); refresh(); },
        },
      ],
    );
  }

  // Denied entries have no Retry path (retrying can never make an
  // authorization denial succeed) — Dismiss just removes the one row the user
  // acknowledged, unlike handleDiscard's bulk "clear every failed entry".
  function handleDismissDenied(id: string) {
    discardDeniedEntry(id);
    refresh();
  }

  // #203: a denied outbox entry never records WHICH permission was missing
  // (engine.ts only classifies "was this a permanent authorization denial",
  // not which check failed) — so unlike PermissionGate's tap-toast, this
  // always asks for the fallback grantor (a manage_roles_permissions holder,
  // i.e. someone who can grant SOMETHING) rather than a holder of the actual
  // missing permission. The draft names the entity from the entry's own
  // friendly message (via entityLabel, the same lookup denialMessage() uses)
  // so the ask is still concrete even though the exact permission isn't known.
  function handleRequestAccess(entry: OutboxEntry) {
    if (!user) return;
    const grantor = pickAccessGrantor('manage_roles_permissions', user);
    if (!grantor) {
      Alert.alert('No one found', 'Could not find anyone else who can grant permissions right now.');
      return;
    }
    // #203: same write-block guard as every other write affordance — during
    // maintenance lock or "Preview as role" this silently no-ops instead of
    // letting an uncaught MaintenanceLockedError escape this handler.
    if (isWriteBlocked()) return;
    const conversationId = createDmConversation(user.id, grantor.id);
    setShowSheet(false);
    router.push({
      pathname: '/(app)/(chat)/[id]',
      params: {
        id: conversationId,
        draft: `Hi ${grantor.name} — a change I made to ${entityLabel(entry.table_name)} was blocked. Could I get access to do that?`,
      },
    });
  }

  const SYNC_COLORS: Record<SyncStatus, string> = {
    synced: t.colors.success,
    pending: t.colors.warning,
    failed: t.colors.danger,
    denied: t.colors.danger,
    offline: t.colors.danger,
  };
  const color = SYNC_COLORS[status];
  const label = {
    synced: 'Synced',
    pending: `${active} pending`,
    failed: `${failed} failed`,
    denied: `${denied.length} denied`,
    offline: 'Offline',
  }[status];

  return (
    <>
      <TouchableOpacity onPress={() => { refresh(); setShowSheet(true); }} style={s.dot}>
        <View style={[s.circle, { backgroundColor: color }]} />
      </TouchableOpacity>

      <Modal visible={showSheet} transparent animationType="slide">
        <Pressable style={s.overlay} onPress={() => setShowSheet(false)}>
          <Pressable style={[s.sheet, { paddingBottom: t.spacing.xxl + insets.bottom }]}>
            <View style={[s.sheetDot, { backgroundColor: color }]} />
            <Text style={s.sheetStatus}>{label}</Text>
            {lastSync && (
              <Text style={s.sheetSub}>
                Last sync: {new Date(lastSync).toLocaleTimeString()}
              </Text>
            )}
            {active > 0 && (
              <Text style={s.sheetSub}>
                {active} change{active !== 1 ? 's' : ''} waiting to upload
              </Text>
            )}
            {failed > 0 && (
              <>
                <Text style={s.sheetFailed}>
                  {failed} change{failed !== 1 ? 's' : ''} failed to sync after several tries.
                </Text>
                {firstError && <Text style={s.sheetErr} numberOfLines={3}>{firstError}</Text>}
                <View style={s.btnRow}>
                  <TouchableOpacity
                    style={[s.btn, s.btnPrimary, busy && s.btnDisabled]}
                    onPress={handleRetry}
                    disabled={busy}
                  >
                    <Text style={s.btnPrimaryText}>{busy ? 'Retrying…' : 'Retry now'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.btn, s.btnDanger]}
                    onPress={handleDiscard}
                    disabled={busy}
                  >
                    <Text style={s.btnDangerText}>Discard</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
            {denied.length > 0 && (
              <>
                <Text style={s.sheetFailed}>
                  {denied.length} change{denied.length !== 1 ? 's' : ''} could not be saved.
                </Text>
                {denied.map(entry => (
                  <View key={entry.id} style={s.deniedRow}>
                    <Text style={s.deniedMsg}>{entry.last_error ?? "Your account can't make this change — it wasn't saved."}</Text>
                    <View style={s.deniedBtnRow}>
                      <TouchableOpacity
                        style={s.deniedRequestBtn}
                        onPress={() => handleRequestAccess(entry)}
                      >
                        <Text style={s.deniedRequestText}>Request access</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[s.btn, s.btnDanger, s.deniedDismissBtn]}
                        onPress={() => handleDismissDenied(entry.id)}
                      >
                        <Text style={s.btnDangerText}>Dismiss</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </>
            )}
            {status === 'offline' && (
              <Text style={s.sheetOffline}>
                Connect to WiFi or cellular to sync your changes.
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  dot: { padding: 6 },
  circle: { width: 10, height: 10, borderRadius: 5 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    backgroundColor: t.colors.surface,
    borderTopLeftRadius: t.radii.xl,
    borderTopRightRadius: t.radii.xl,
    padding: t.spacing.xxl,
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  sheetDot: { width: 16, height: 16, borderRadius: 8, marginBottom: 4 },
  sheetStatus: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  sheetSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary },
  sheetFailed: { fontSize: t.typography.fontSizes.body, color: t.colors.danger, textAlign: 'center', marginTop: 4, fontWeight: '600' },
  sheetErr: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, textAlign: 'center', fontStyle: 'italic' },
  sheetOffline: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, textAlign: 'center', marginTop: 4 },
  btnRow: { flexDirection: 'row', gap: t.spacing.md, marginTop: t.spacing.md },
  btn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: t.radii.md, minWidth: 110, alignItems: 'center' },
  btnPrimary: { backgroundColor: t.colors.primary },
  btnPrimaryText: { color: t.colors.surface, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  btnDanger: { backgroundColor: t.colors.dangerBg },
  btnDangerText: { color: t.colors.danger, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  btnDisabled: { opacity: 0.6 },
  deniedRow: { width: '100%', alignItems: 'center', gap: t.spacing.xs, marginTop: t.spacing.sm },
  deniedMsg: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, textAlign: 'center' },
  deniedBtnRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  deniedRequestBtn: { paddingVertical: 6, paddingHorizontal: 12 },
  deniedRequestText: { color: t.colors.accent, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  deniedDismissBtn: { minWidth: 0, paddingVertical: 6, paddingHorizontal: 16 },
});
