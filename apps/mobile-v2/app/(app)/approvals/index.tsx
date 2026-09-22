// NEW route this station — the old app never had a standalone approvals
// worklist screen (approval_requests existed only as a synced table + the
// manual RequestApprovalSheet entry point; decisions were presumably made
// server-side/admin-side, not from a dedicated mobile screen — see
// apps/mobile/src/db/queries/notifications.ts, which has no caller for
// decideApproval anywhere in the old app). This screen is the first mobile
// consumer of decideApproval: a simple pending queue with approve/deny.
//
// decideApproval (repos/approvals.ts) never self-logged in the old app either
// (grep confirmed no appendLog in its outbox write) — no divergence, no
// appendLog call needed here.
//
// Gating: there's no dedicated "approver" permission in the role model (the
// server resolves approvers per-request via its own callerIsApprover logic —
// see apps/api). This screen courtesy-gates decide actions on manage_teams
// (the closest existing "has authority over people" permission) so the
// button isn't shown to line technicians; the server remains the enforcement
// of record and will reject a decision from a non-approver regardless.
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { Alert, useTheme, useThemedStyles, Card, EmptyState, confirmSheet } from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';
import { listOpenApprovals, decideApproval, type ApprovalRequestRow } from '../../../src/repos/approvals';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function ApprovalsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { realUser } = useSession();
  const canDecide = usePermission('manage_teams');
  const { locked } = useMaintenanceMode();
  const [refreshing, setRefreshing] = useState(false);

  const requests = useDbQuery(() => listOpenApprovals(), [], ['approval_requests']);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — nothing to sync */ }
    setRefreshing(false);
  };

  async function handleApprove(r: ApprovalRequestRow) {
    if (isWriteBlocked() || !realUser) return;
    decideApproval(r.id, 'approved', realUser.id);
  }

  async function handleReject(r: ApprovalRequestRow) {
    if (isWriteBlocked() || !realUser) return;
    const ok = await confirmSheet({
      title: 'Deny request', message: `Deny "${r.title}"?`, confirmLabel: 'Deny', destructive: true,
    });
    if (!ok) return;
    try {
      decideApproval(r.id, 'rejected', realUser.id);
    } catch {
      Alert.alert('Could not deny', 'Please try again.');
    }
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Approvals', headerShown: true }} />
      <View style={s.container}>
        <ScrollView
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.primary} colors={[t.colors.primary]} />
          }
        >
          {requests.length === 0 ? (
            <EmptyState icon="✅" title="Nothing pending" subtitle="Approval requests will show up here." />
          ) : (
            requests.map(r => (
              <Card key={r.id} variant="list">
                <Text style={s.title}>{r.title}</Text>
                {r.detail ? <Text style={s.detail}>{r.detail}</Text> : null}
                <Text style={s.meta}>{formatWhen(r.created_at)} · {r.kind}</Text>
                {canDecide && (
                  <View style={s.actions}>
                    <TouchableOpacity
                      style={[s.actionBtn, s.approveBtn]}
                      onPress={() => handleApprove(r)}
                      disabled={locked}
                    >
                      <Text style={s.approveText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.actionBtn, s.rejectBtn]}
                      onPress={() => handleReject(r)}
                      disabled={locked}
                    >
                      <Text style={s.rejectText}>Deny</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </Card>
            ))
          )}
        </ScrollView>
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  title: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  detail: { fontSize: 13, color: t.colors.textSecondary, marginTop: 4 },
  meta: { fontSize: 11, color: t.colors.textMuted, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  approveBtn: { backgroundColor: t.colors.successBg },
  approveText: { color: t.colors.success, fontWeight: '700', fontSize: 13 },
  rejectBtn: { backgroundColor: t.colors.dangerBg },
  rejectText: { color: t.colors.danger, fontWeight: '700', fontSize: 13 },
});
