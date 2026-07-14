import { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { getValidJwt } from '../../../src/auth/session';
import { colors, spacing, fontSizes, radii } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

interface NameCount { name: string; count: number }
interface DayCount { day: string; count: number }
interface UserActivity { userId: string; name: string; role: string; count: number }
interface Summary {
  windowDays: number;
  totals: { events: number; sessions: number; users: number; devices: number; errors: number };
  active: { users: number; devices: number; sessions: number; anonSessions: number };
  topScreens: NameCount[];
  topActions: NameCount[];
  topErrors: NameCount[];
  errorTrend: DayCount[];
  topAuditActions: NameCount[];
  deviceTrend: DayCount[];
  byUser: UserActivity[];
  byRole: NameCount[];
  byTeam: NameCount[];
  byPlatform: { platform: string; count: number }[];
  byVersion: { version: string; count: number }[];
}

// Roles come off the wire as snake_case enum keys; humanize for display.
function humanizeRole(r: string): string {
  return r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const WINDOWS = [
  { label: '24h', days: 1 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

export default function AnalyticsScreen() {
  const isAdmin = usePermission('system_settings');
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const jwt = await getValidJwt();
      if (!jwt) { setError('Sign in required to view analytics.'); return; }
      const res = await fetch(`${API_BASE}/telemetry/summary?days=${days}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.status === 403) { setError('You don’t have permission to view analytics.'); return; }
      if (!res.ok) { setError('Couldn’t load analytics — this screen needs a connection.'); return; }
      setData((await res.json()) as Summary);
    } catch {
      setError('Couldn’t reach the server. Analytics is live data (not offline).');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Analytics' }} />
        <Text style={s.muted}>You don’t have access to analytics.</Text>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Analytics' }} />
      <ScrollView
        contentContainerStyle={{ padding: spacing.base, paddingBottom: spacing.xl }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
      >
        <View style={s.windowRow}>
          {WINDOWS.map(w => (
            <FilterChip key={w.days} label={w.label} active={days === w.days} onPress={() => setDays(w.days)} />
          ))}
        </View>

        {loading && !data ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
        ) : error ? (
          <View style={s.card}>
            <Text style={s.errorText}>{error}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={load}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : data ? (
          <>
            <View style={s.tileRow}>
              <Stat label="Events" value={data.totals.events} />
              <Stat label="Sessions" value={data.totals.sessions} />
            </View>
            <View style={s.tileRow}>
              <Stat label="Active users" value={data.totals.users} />
              <Stat label="Devices" value={data.totals.devices} />
              <Stat label="Errors" value={data.totals.errors} danger={data.totals.errors > 0} />
            </View>

            <View style={s.tileRow}>
              <Stat label="Active users" value={data.active.users} />
              <Stat label="Active devices" value={data.active.devices} />
              <Stat label="Anon sessions" value={data.active.anonSessions} />
            </View>

            <BarList title="Top screens" items={data.topScreens} />
            <BarList title="Top actions" items={data.topActions} />

            <TrendChart title="Error trend" data={data.errorTrend} />
            <BarList title="Top errors" items={data.topErrors} accent={colors.danger} emptyGood />

            <BarList title="Business actions" items={data.topAuditActions ?? []} />
            <TrendChart title="Active devices" data={data.deviceTrend ?? []} accentColor={colors.primary} />

            <BarList
              title="Top users"
              items={data.byUser.map(u => ({ name: u.name, count: u.count }))}
            />
            <BarList title="Activity by role" items={data.byRole.map(r => ({ name: humanizeRole(r.name), count: r.count }))} />
            <BarList title="Activity by team" items={data.byTeam} />

            <BarList title="Platform" items={data.byPlatform.map(p => ({ name: p.platform, count: p.count }))} />
            <BarList title="App version" items={data.byVersion.map(v => ({ name: v.version, count: v.count }))} />

            <Text style={s.footnote}>
              Live server data over the last {data.windowDays === 1 ? '24h' : `${data.windowDays} days`}. Behavioral
              telemetry is non-PII, never synced to devices, and pruned at 90 days.
            </Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <View style={s.tile}>
      <Text style={[s.tileValue, danger && { color: colors.danger }]}>{value.toLocaleString()}</Text>
      <Text style={s.tileLabel}>{label}</Text>
    </View>
  );
}

function BarList({ title, items, accent, emptyGood }: {
  title: string; items: NameCount[]; accent?: string; emptyGood?: boolean;
}) {
  const max = items.reduce((m, i) => Math.max(m, i.count), 0) || 1;
  const barColor = accent ?? colors.primary;
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {items.length === 0 ? (
        <Text style={s.muted}>{emptyGood ? 'None 🎉' : 'No data yet.'}</Text>
      ) : (
        items.map((i, idx) => (
          <View key={`${i.name}-${idx}`} style={s.barRow}>
            <Text style={s.barName} numberOfLines={1}>{i.name}</Text>
            <View style={s.barTrack}>
              <View style={[s.barFill, { width: `${Math.max(4, (i.count / max) * 100)}%`, backgroundColor: barColor }]} />
            </View>
            <Text style={s.barCount}>{i.count.toLocaleString()}</Text>
          </View>
        ))
      )}
    </View>
  );
}

// Change-over-time: a single-series daily column chart. Per dataviz — one series
// needs no legend (the title names it), thin marks with rounded data-ends
// anchored to the baseline, a recessive track, and selective direct labels
// (peak value + first/last day only, never a number on every column).
function TrendChart({ title, data, accentColor }: { title: string; data: DayCount[]; accentColor?: string }) {
  const barColor = accentColor ?? colors.danger;
  const max = data.reduce((m, d) => Math.max(m, d.count), 0);
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const peakIdx = max > 0 ? data.findIndex(d => d.count === max) : -1;
  const fmtDay = (day: string) => {
    const [, m, d] = day.split('-');
    return m && d ? `${Number(m)}/${Number(d)}` : day;
  };
  return (
    <View style={s.card}>
      <View style={s.trendHeader}>
        <Text style={s.cardTitle}>{title}</Text>
        <Text style={s.trendTotal}>{total.toLocaleString()} total</Text>
      </View>
      {total === 0 ? (
        <Text style={s.muted}>None 🎉</Text>
      ) : (
        <>
          <View style={s.trendPlot}>
            {data.map((d, idx) => (
              <View key={d.day} style={s.trendCol}>
                {idx === peakIdx ? <Text style={[s.trendPeak, { color: barColor }]}>{d.count}</Text> : <View style={s.trendPeakSpacer} />}
                <View
                  style={[
                    s.trendBar,
                    {
                      height: `${max > 0 ? Math.max(d.count > 0 ? 6 : 0, (d.count / max) * 100) : 0}%`,
                      backgroundColor: d.count > 0 ? barColor : 'transparent',
                    },
                  ]}
                />
              </View>
            ))}
          </View>
          <View style={s.trendAxis}>
            <Text style={s.trendAxisLabel}>{fmtDay(data[0].day)}</Text>
            <Text style={s.trendAxisLabel}>{fmtDay(data[data.length - 1].day)}</Text>
          </View>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { color: colors.textMuted, fontSize: fontSizes.body },
  windowRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.base, flexWrap: 'wrap' },
  tileRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  tile: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radii.md,
    paddingVertical: spacing.base, paddingHorizontal: spacing.sm, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  tileValue: { fontSize: fontSizes.lg, fontWeight: '800', color: colors.textPrimary },
  tileLabel: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 2, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.base,
    marginTop: spacing.base, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  cardTitle: { fontSize: fontSizes.body, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  barRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, gap: spacing.sm },
  barName: { width: '38%', fontSize: fontSizes.caption, color: colors.textSecondary },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.background, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  barCount: { width: 52, textAlign: 'right', fontSize: fontSizes.caption, fontWeight: '700', color: colors.textPrimary },
  trendHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.sm },
  trendTotal: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary },
  trendPlot: { flexDirection: 'row', alignItems: 'flex-end', height: 88, gap: 2 },
  trendCol: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' },
  trendBar: { width: '100%', borderTopLeftRadius: 4, borderTopRightRadius: 4, minWidth: 3 },
  trendPeak: { fontSize: fontSizes.xs, fontWeight: '700', color: colors.danger, marginBottom: 2 },
  trendPeakSpacer: { height: fontSizes.xs + 2 },
  trendAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  trendAxisLabel: { fontSize: fontSizes.xs, color: colors.textMuted },
  errorText: { color: colors.textSecondary, fontSize: fontSizes.body },
  retryBtn: { marginTop: spacing.sm, alignSelf: 'flex-start', paddingVertical: spacing.xs, paddingHorizontal: spacing.base, borderRadius: radii.sm, backgroundColor: colors.primaryBg },
  retryText: { color: colors.primaryText, fontWeight: '700' },
  footnote: { marginTop: spacing.base, fontSize: fontSizes.caption, color: colors.textMuted, lineHeight: 18 },
});
