import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, Card, EmptyState, Fab, FieldLabel } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';
import { usePermission } from '../../../src/hooks/usePermission';
import { OnCallCalendar } from '../../../src/components/oncall/OnCallCalendar';
import { CoverageSheet } from '../../../src/components/oncall/CoverageSheet';
import { formatDayLabel } from '../../../src/components/schedule/dayMath';
import { addDaysIso, localTodayIso } from '../../../src/components/oncall/weekMath';
import { getCoverage, type CoverageRow } from '../../../src/repos/oncall';

// Station C2: NEW on-call surface (no old-app equivalent — the old app only
// had a widget/calendar embedded elsewhere plus a create-only CoverageSheet;
// this is a genuine full-page screen combining both on_call_shifts (the week
// grid, ported OnCallCalendar) and on_call_coverage (list + detail + create/
// edit + delete, ported+extended CoverageSheet) so every table this station
// covers is reachable per the mechanical definition of done.
//
// Both write surfaces gate on `manage_teams` (server OPERATION_PERM for
// on_call_shifts/on_call_coverage INSERT/UPDATE/DELETE — see apps/api/src/
// lib/syncPolicy.ts) — same permission covers the week grid's tap-to-assign
// AND the coverage list's create/edit/delete affordances. Settings (week
// boundary + rotation order) lives at its own route, gated `system_settings`
// like the old app's on-call-settings screen.
//
// Coverage window: 30 days back (recently-ended entries still visible for a
// beat) through 180 days forward (long enough to see planned PTO/coverage
// without an unbounded list) — a fixed window, not paginated; the mechanical
// DoD only requires every row be reachable, not infinite scroll.
const COVERAGE_WINDOW_PAST_DAYS = 30;
const COVERAGE_WINDOW_FUTURE_DAYS = 180;

export default function OnCallScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const canEdit = usePermission('manage_teams');
  const canConfigure = usePermission('system_settings');

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingCoverage, setEditingCoverage] = useState<CoverageRow | null>(null);

  const { fromIso, toIso } = useMemo(() => {
    const today = localTodayIso();
    return { fromIso: addDaysIso(today, -COVERAGE_WINDOW_PAST_DAYS), toIso: addDaysIso(today, COVERAGE_WINDOW_FUTURE_DAYS) };
  }, []);

  const coverage = useDbQuery<CoverageRow[]>(
    () => getCoverage(fromIso, toIso),
    [fromIso, toIso],
    ['on_call_coverage', 'users'],
  );

  function openCreate() {
    setEditingCoverage(null);
    setSheetOpen(true);
  }
  function openEdit(row: CoverageRow) {
    setEditingCoverage(row);
    setSheetOpen(true);
  }

  return (
    <View style={s.flex}>
      <Stack.Screen
        options={{
          title: 'On-Call',
          headerShown: true,
          headerRight: canConfigure
            ? () => (
                <TouchableOpacity onPress={() => router.push({ pathname: '/(app)/oncall/settings' })} hitSlop={8}>
                  <Text style={s.headerLink}>Settings</Text>
                </TouchableOpacity>
              )
            : undefined,
        }}
      />
      <ScrollView style={s.flex} contentContainerStyle={s.content}>
        <Text style={s.sectionTitle}>Week grid</Text>
        <Card>
          <OnCallCalendar canEdit={canEdit} />
        </Card>

        <Text style={s.sectionTitle}>Coverage</Text>
        {coverage.length === 0 ? (
          <EmptyState icon="🧑‍🤝‍🧑" title="No coverage entries" subtitle="Time-off coverage for the next few months will appear here." />
        ) : (
          <View style={s.coverageList}>
            {coverage.map(row => (
              <TouchableOpacity key={row.id} onPress={() => canEdit && openEdit(row)} activeOpacity={canEdit ? 0.7 : 1}>
                <Card style={s.coverageCard}>
                  <Text style={s.coverageRange}>{formatDayLabel(row.date_start)} – {formatDayLabel(row.date_end)}</Text>
                  <Text style={s.coverageNames}>
                    {row.covering_user_name ?? 'Someone'} covering for {row.user_off_name ?? 'someone'}
                  </Text>
                  {!!row.note && <Text style={s.coverageNote}>{row.note}</Text>}
                </Card>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <FieldLabel style={s.hint}>
          {canEdit ? 'Tap a row to edit or delete it.' : 'Coverage entries are read-only for your role.'}
        </FieldLabel>
      </ScrollView>
      {canEdit && <Fab onPress={openCreate} label="Add Coverage" />}
      <CoverageSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} coverage={editingCoverage} />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, paddingBottom: 96, gap: t.spacing.sm },
  sectionTitle: {
    fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary,
    marginTop: t.spacing.md, marginBottom: t.spacing.xs,
  },
  headerLink: { fontSize: t.typography.fontSizes.body, color: t.colors.primaryText, fontWeight: '600' },
  coverageList: { gap: t.spacing.sm },
  coverageCard: { gap: 2 },
  coverageRange: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  coverageNames: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary },
  coverageNote: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
  hint: { marginTop: t.spacing.sm },
});
