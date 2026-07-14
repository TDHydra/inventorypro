import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput,
  ActivityIndicator, RefreshControl, ScrollView, Platform,
} from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { usePermission } from '../../../src/hooks/usePermission';
import { getValidJwt } from '../../../src/auth/session';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { MapDisplay } from '../../../src/components/MapDisplay';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

// Server page size for the audit list (keyset-paginated, see `next` cursor).
const PAGE_SIZE = 40;

// ── Wire types (mirror GET /audit) ──────────────────────────────────────────

type Outcome = 'success' | 'denied' | 'rate_limited' | 'validation_reject' | 'client_error' | 'server_error';
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface AuditRow {
  id: string;
  request_id: string;
  occurred_at: string; // ISO timestamptz, UTC — always render in device-local tz
  user_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  method: Method;
  route: string; // template, e.g. /users/:id
  path: string; // concrete path, query stripped
  status_code: number;
  outcome: Outcome;
  duration_ms: number | null;
  ip: string | null;
  user_agent: string | null;
  device_id: string | null; // null unless caller is full_admin
  platform: string | null;
  app_version: string | null;
  error_message: string | null;
  security_class: boolean;
}

// Private/reserved addresses can't be geolocated — hide the map button rather
// than send an admin to a meaningless pin. (Pre-TRUST_PROXY-fix audit rows all
// carry the unraid proxy's 192.168.1.239, so old rows simply get no button.)
function isMappableIp(ip: string): boolean {
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (ip === '::1' || /^(fc|fd|fe80)/i.test(ip)) return false;
  return true;
}

// Where a tapped IP resolves to — feeds the in-app map sheet.
interface IpGeo {
  ip: string;
  latitude: number;
  longitude: number;
  place: string; // "City, Region, Country" — best-effort caption
}

// Geolocate the IP for the in-app map. The IP is sent to a third-party lookup
// service (ipwho.is — keyless, HTTPS, CORS-enabled so it also works on web)
// only when an admin explicitly taps, never automatically. Returns null when
// the IP can't be placed.
async function lookupIpGeo(ip: string): Promise<IpGeo | null> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
    const geo = await res.json() as {
      success?: boolean; latitude?: number; longitude?: number;
      city?: string; region?: string; country?: string;
    };
    if (!geo.success || typeof geo.latitude !== 'number' || typeof geo.longitude !== 'number') return null;
    const place = [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
    return { ip, latitude: geo.latitude, longitude: geo.longitude, place };
  } catch {
    return null;
  }
}

interface Cursor { before_ts: string; before_id: string }

interface AuditResponse {
  rows: AuditRow[];
  masked: boolean;
  debug: boolean;
  next: Cursor | null;
}

interface ActivityRow {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  note: string | null;
  created_at: string;
  metadata: unknown;
}

// ── Filter option tables ─────────────────────────────────────────────────────

const OUTCOMES: { label: string; value: Outcome | null }[] = [
  { label: 'All', value: null },
  { label: 'Success', value: 'success' },
  { label: 'Denied', value: 'denied' },
  { label: 'Rate limited', value: 'rate_limited' },
  { label: 'Validation reject', value: 'validation_reject' },
  { label: 'Client error', value: 'client_error' },
  { label: 'Server error', value: 'server_error' },
];

const OUTCOME_LABELS: Record<Outcome, string> = {
  success: 'Success',
  denied: 'Denied',
  rate_limited: 'Rate limited',
  validation_reject: 'Validation reject',
  client_error: 'Client error',
  server_error: 'Server error',
};

// Pill color per the spec: success=green, denied/rate_limited=amber,
// validation_reject=dark amber (warning-ish but distinct — the theme's only
// warning tone is already taken by denied/rate_limited), errors=red.
const VALIDATION_REJECT_COLOR = '#B45309';

function outcomeColor(o: Outcome): string {
  switch (o) {
    case 'success': return colors.success;
    case 'denied':
    case 'rate_limited': return colors.warning;
    case 'validation_reject': return VALIDATION_REJECT_COLOR;
    case 'client_error':
    case 'server_error': return colors.danger;
  }
}

// Roles arrive as snake_case enum keys; humanize for display.
function humanizeRole(r: string): string {
  return r.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Compact relative label off the DEVICE clock; falls back to a local date for
// anything older than a week. occurred_at is UTC, so Date parses it correctly
// and every derived value is in the device's local timezone.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}

const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

type Phase = 'loading' | 'ready' | 'error' | 'forbidden';

export default function AuditLogScreen() {
  const canView = usePermission('view_audit_log');

  // Filter inputs
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [securityOnly, setSecurityOnly] = useState(false);
  const [q, setQ] = useState('');

  // List state
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [masked, setMasked] = useState(true);
  const [debug, setDebug] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [errMsg, setErrMsg] = useState('Couldn’t reach the server. The audit log is live data (not offline).');
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Guards a single in-flight request so a fast scroll or double pull-to-refresh
  // can't fire overlapping fetches that interleave pages.
  const inFlight = useRef(false);

  // Detail modal
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [mapLookupBusy, setMapLookupBusy] = useState(false);
  const [ipMap, setIpMap] = useState<IpGeo | null>(null);
  const [activityError, setActivityError] = useState(false);

  // Build the query string from the current filters (+ optional keyset cursor).
  const buildQuery = useCallback((c: Cursor | null): string => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (outcome) params.set('outcome', outcome);
    if (securityOnly) params.set('security_only', '1');
    const term = q.trim();
    if (term) params.set('q', term);
    if (c) {
      params.set('before_ts', c.before_ts);
      params.set('before_id', c.before_id);
    }
    return params.toString();
  }, [outcome, securityOnly, q]);

  // Load the first page (fresh cursor). `isRefresh` drives which spinner shows.
  const loadInitial = useCallback(async (isRefresh: boolean) => {
    if (!canView) return;
    if (inFlight.current) return;
    inFlight.current = true;
    if (isRefresh) setRefreshing(true); else setPhase('loading');
    try {
      const jwt = await getValidJwt();
      if (!jwt) {
        setErrMsg('Sign in required to view the audit log.');
        setPhase('error');
        return;
      }
      const res = await fetch(`${API_BASE}/audit?${buildQuery(null)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (res.status === 403) { setPhase('forbidden'); return; }
      if (!res.ok) {
        setErrMsg('Couldn’t load the audit log — this screen needs a connection.');
        setPhase('error');
        return;
      }
      const data = (await res.json()) as AuditResponse;
      setRows(data.rows);
      setCursor(data.next);
      setHasMore(data.next !== null);
      setMasked(data.masked);
      setDebug(data.debug);
      setPhase('ready');
    } catch {
      setErrMsg('Couldn’t reach the server. The audit log is live data (not offline).');
      setPhase('error');
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [canView, buildQuery]);

  // Append the next keyset page. Stops at end (cursor === null) and never uses
  // an offset — the cursor is the server-issued (before_ts, before_id) pair.
  const loadMore = useCallback(async () => {
    if (!canView || phase !== 'ready' || !hasMore || !cursor) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setLoadingMore(true);
    try {
      const jwt = await getValidJwt();
      if (!jwt) return;
      const res = await fetch(`${API_BASE}/audit?${buildQuery(cursor)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as AuditResponse;
      setRows(prev => [...prev, ...data.rows]);
      setCursor(data.next);
      setHasMore(data.next !== null);
      setMasked(data.masked);
      setDebug(data.debug);
    } catch {
      // Keep what we have; user can pull-to-refresh or scroll again to retry.
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }, [canView, phase, hasMore, cursor, buildQuery]);

  // Reload page 1 whenever a filter changes (debounced so typing in `q` — a
  // server-side prefix match — doesn't fire a request per keystroke).
  useEffect(() => {
    if (!canView) return;
    const t = setTimeout(() => { void loadInitial(false); }, 300);
    return () => clearTimeout(t);
  }, [canView, loadInitial]);

  // Fetch the business actions correlated to the tapped request.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setActivity(null);
    setActivityError(false);
    setActivityLoading(true);
    void (async () => {
      try {
        const jwt = await getValidJwt();
        if (!jwt) {
          if (!cancelled) { setActivityError(true); setActivityLoading(false); }
          return;
        }
        const res = await fetch(
          `${API_BASE}/audit/${encodeURIComponent(selected.request_id)}/activity`,
          { headers: { Authorization: `Bearer ${jwt}` } },
        );
        if (!res.ok) {
          if (!cancelled) { setActivityError(true); setActivityLoading(false); }
          return;
        }
        const data = (await res.json()) as { rows: ActivityRow[] };
        if (!cancelled) { setActivity(data.rows); setActivityLoading(false); }
      } catch {
        if (!cancelled) { setActivityError(true); setActivityLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  if (!canView) {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ title: 'API Audit', headerShown: true }} />
        <EmptyState
          title="You don’t have access to the API audit log."
          subtitle="Ask an administrator to grant the audit-log permission."
        />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'API Audit', headerShown: true }} />
      <View style={s.container}>
        {debug && (
          <View style={s.debugBanner}>
            <Text style={s.debugText}>
              Debug capture is ON — every request is being recorded, including sync polls.
            </Text>
          </View>
        )}

        <Text style={s.subtitle}>
          Who called the API, when, and whether it succeeded — newest first.
        </Text>

        {/* Outcome + security filters (horizontally scrollable on narrow screens). */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.chipRow}
          keyboardShouldPersistTaps="handled"
        >
          {OUTCOMES.map(o => (
            <FilterChip
              key={o.label}
              label={o.label}
              active={outcome === o.value}
              onPress={() => setOutcome(o.value)}
            />
          ))}
          <FilterChip
            label="Security only"
            active={securityOnly}
            onPress={() => setSecurityOnly(v => !v)}
          />
        </ScrollView>

        <TextInput
          style={s.search}
          placeholder="Filter by path, e.g. /users"
          placeholderTextColor={colors.textMuted}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />

        {phase === 'forbidden' ? (
          <EmptyState
            title="You don’t have access to the API audit log."
            subtitle="Ask an administrator to grant the audit-log permission."
          />
        ) : phase === 'loading' ? (
          <View style={s.center}><ActivityIndicator color={colors.primary} /></View>
        ) : phase === 'error' ? (
          <View style={s.center}>
            <Text style={s.errorText}>{errMsg}</Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => void loadInitial(false)}>
              <Text style={s.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList<AuditRow>
            data={rows}
            keyExtractor={r => r.id}
            contentContainerStyle={s.list}
            keyboardShouldPersistTaps="handled"
            onEndReachedThreshold={0.4}
            onEndReached={() => void loadMore()}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void loadInitial(true)}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
            renderItem={({ item }) => (
              <TouchableOpacity style={s.row} activeOpacity={0.7} onPress={() => setSelected(item)}>
                <View style={[s.pill, { backgroundColor: outcomeColor(item.outcome) }]}>
                  <Text style={s.pillText}>{OUTCOME_LABELS[item.outcome]}</Text>
                </View>
                <View style={s.rowMid}>
                  <Text style={s.mono} numberOfLines={1}>
                    {item.security_class ? '🔒 ' : ''}{item.method} {item.path}
                  </Text>
                  <Text style={s.actor} numberOfLines={1}>
                    {(item.actor_name ?? 'anonymous')} · {item.actor_role ? humanizeRole(item.actor_role) : '—'}
                  </Text>
                </View>
                <View style={s.rowRight}>
                  <Text style={[s.status, { color: outcomeColor(item.outcome) }]}>{item.status_code}</Text>
                  <Text style={s.meta}>{item.duration_ms != null ? `${item.duration_ms}ms` : '—'}</Text>
                  <Text style={s.meta}>{relativeTime(item.occurred_at)}</Text>
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <EmptyState
                title="No API calls"
                subtitle="No requests match these filters."
              />
            }
            ListFooterComponent={
              loadingMore ? (
                <View style={s.footer}><ActivityIndicator color={colors.primary} /></View>
              ) : (!hasMore && rows.length > 0) ? (
                <Text style={s.endNote}>End of log</Text>
              ) : null
            }
          />
        )}
      </View>

      {/* ── Detail sheet ─────────────────────────────────────────────────── */}
      <ModalSheet visible={selected !== null} onClose={() => setSelected(null)}>
        {selected && (
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={s.sheetHeader}>
              <View style={[s.pill, { backgroundColor: outcomeColor(selected.outcome) }]}>
                <Text style={s.pillText}>{OUTCOME_LABELS[selected.outcome]}</Text>
              </View>
              <TouchableOpacity onPress={() => setSelected(null)} hitSlop={10}>
                <Text style={s.close}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={[s.mono, s.sheetPath]}>{selected.method} {selected.path}</Text>

            <Field label="Route" value={selected.route} mono />
            <Field label="Status" value={String(selected.status_code)} />
            <Field label="Outcome" value={OUTCOME_LABELS[selected.outcome]} />
            <Field label="Duration" value={selected.duration_ms != null ? `${selected.duration_ms} ms` : '—'} />
            {/* occurred_at is UTC ISO — toLocaleString renders it in device-local time. */}
            <Field label="When" value={new Date(selected.occurred_at).toLocaleString()} />
            <Field label="Actor" value={selected.actor_name ?? 'anonymous'} />
            <Field label="Role" value={selected.actor_role ? humanizeRole(selected.actor_role) : '—'} />
            <Field label="User ID" value={selected.user_id ?? '—'} mono />
            <Field label="Platform" value={selected.platform ?? '—'} />
            <Field label="App version" value={selected.app_version ?? '—'} />
            <Field label="Request ID" value={selected.request_id} mono />
            <Field label="Security-classed" value={selected.security_class ? 'Yes' : 'No'} />
            {selected.error_message ? (
              <Field label="Error" value={selected.error_message} danger />
            ) : null}

            {masked ? (
              <Text style={s.note}>IP and device are visible to full admins only.</Text>
            ) : (
              <>
                <View style={s.field}>
                  <Text style={s.fieldLabel}>IP</Text>
                  {selected.ip && isMappableIp(selected.ip) ? (
                    // The IP itself is the hyperlink: tap → geolocate → in-app
                    // map sheet. Private/pre-fix proxy IPs stay plain text.
                    <View style={s.ipRow}>
                      {mapLookupBusy ? <ActivityIndicator size="small" color={colors.primary} /> : null}
                      <TouchableOpacity
                        hitSlop={10}
                        disabled={mapLookupBusy}
                        onPress={() => {
                          const ip = selected.ip!;
                          setMapLookupBusy(true);
                          void lookupIpGeo(ip)
                            .then(geo => {
                              if (geo) setIpMap(geo);
                              else Alert.alert('Could not locate IP', 'The lookup service could not place this address.');
                            })
                            .finally(() => setMapLookupBusy(false));
                        }}
                      >
                        <Text style={[s.fieldValue, s.mono, s.ipLink]}>{selected.ip}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <Text style={[s.fieldValue, s.mono]} selectable>{selected.ip ?? '—'}</Text>
                  )}
                </View>
                <Field label="Device ID" value={selected.device_id ?? '—'} mono />
                <Field label="User agent" value={selected.user_agent ?? '—'} />
              </>
            )}

            <Text style={s.sectionTitle}>Correlated activity</Text>
            {activityLoading ? (
              <View style={s.footer}><ActivityIndicator color={colors.primary} /></View>
            ) : activityError ? (
              <Text style={s.note}>Couldn’t load correlated activity.</Text>
            ) : activity && activity.length > 0 ? (
              activity.map(a => (
                <View key={a.id} style={s.activityRow}>
                  <Text style={s.activityAction}>{a.action}</Text>
                  {a.entity_type ? (
                    <Text style={s.activityMeta}>{a.entity_type}{a.entity_id ? ` · ${a.entity_id}` : ''}</Text>
                  ) : null}
                  {a.note ? <Text style={s.activityNote}>{a.note}</Text> : null}
                  <Text style={s.activityMeta}>{new Date(a.created_at).toLocaleString()}</Text>
                </View>
              ))
            ) : (
              <Text style={s.note}>No server-recorded actions for this request.</Text>
            )}

            <Text style={s.caption}>
              Only server-side actions (sign-in, PIN setup) are linked to their request. Actions made
              offline on a device are uploaded later by a sync and are not linked to the moment they
              happened.
            </Text>
          </ScrollView>
        )}
      </ModalSheet>

      {/* In-app IP location: a view-only interactive map (pan/zoom, nothing
          else) — MapDisplay is the vendored Leaflet+OSM WebView already used by
          the jobs/logs screens, so no new dependency and no API key. */}
      <ModalSheet visible={ipMap != null} onClose={() => setIpMap(null)}>
        {ipMap && (
          <>
            <Text style={s.mapTitle}>Approximate IP location</Text>
            <Text style={[s.mono, s.mapIp]} selectable>{ipMap.ip}</Text>
            <MapDisplay latitude={ipMap.latitude} longitude={ipMap.longitude} height={380} />
            <Text style={s.mapCaption}>
              ≈ {ipMap.place || 'Unknown area'} · IP-based geolocation is city-level at best, not an
              exact address.
            </Text>
          </>
        )}
      </ModalSheet>
    </>
  );
}

function Field({ label, value, mono, danger }: { label: string; value: string; mono?: boolean; danger?: boolean }) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <Text
        style={[s.fieldValue, mono && s.mono, danger && { color: colors.danger }]}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  subtitle: { fontSize: fontSizes.body2, color: colors.textSecondary, paddingHorizontal: spacing.lg, paddingTop: spacing.md },

  debugBanner: {
    backgroundColor: colors.dangerBg, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.danger,
  },
  debugText: { color: colors.danger, fontSize: fontSizes.body2, fontWeight: '700' },

  chipRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  search: {
    marginHorizontal: spacing.lg, marginBottom: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.md, height: 44, fontSize: fontSizes.body2, color: colors.textPrimary,
  },

  list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxxl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  pill: { borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 3, alignSelf: 'flex-start' },
  pillText: { color: '#fff', fontSize: fontSizes.xs, fontWeight: '800' },
  rowMid: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: fontSizes.body2, color: colors.textPrimary },
  actor: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 2 },
  rowRight: { alignItems: 'flex-end' },
  status: { fontSize: fontSizes.body, fontWeight: '800' },
  meta: { fontSize: fontSizes.xs, color: colors.textMuted, marginTop: 1 },

  footer: { paddingVertical: spacing.lg, alignItems: 'center' },
  endNote: { textAlign: 'center', color: colors.textMuted, fontSize: fontSizes.caption, paddingVertical: spacing.lg },

  errorText: { color: colors.textSecondary, fontSize: fontSizes.body, textAlign: 'center' },
  retryBtn: { paddingVertical: spacing.xs, paddingHorizontal: spacing.base, borderRadius: radii.sm, backgroundColor: colors.primaryBg },
  retryText: { color: colors.primaryText, fontWeight: '700' },

  // Detail sheet
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  close: { fontSize: fontSizes.lg, color: colors.textMuted, padding: 4 },
  sheetPath: { fontSize: fontSizes.body, marginBottom: spacing.md },
  field: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 5 },
  fieldLabel: { fontSize: fontSizes.caption, color: colors.textMuted, flexShrink: 0 },
  fieldValue: { fontSize: fontSizes.body2, color: colors.textPrimary, flex: 1, textAlign: 'right' },
  ipRow: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.md },
  ipLink: { color: colors.primary, textDecorationLine: 'underline' },
  mapTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.xs },
  mapIp: { color: colors.textSecondary, marginBottom: spacing.md },
  mapCaption: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: spacing.md, marginBottom: spacing.md },
  note: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: spacing.xs, fontStyle: 'italic' },
  sectionTitle: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.lg, marginBottom: spacing.sm },
  activityRow: { paddingVertical: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderDetail },
  activityAction: { fontSize: fontSizes.body2, fontWeight: '700', color: colors.textPrimary },
  activityMeta: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: 2 },
  activityNote: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 2 },
  caption: { fontSize: fontSizes.caption, color: colors.textMuted, lineHeight: 18, marginTop: spacing.lg },
});
