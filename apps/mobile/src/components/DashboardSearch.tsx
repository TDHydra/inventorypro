import { useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { searchEverything } from '../db/queries/search';
import { formatQuantity } from '../constants/units';
import { VehicleSheet } from './vehicles/VehicleSheet';
import { LockerSheet } from './lockers/LockerSheet';
import { track } from '../telemetry';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { useDataVersion } from '../hooks/useDataVersion';

/**
 * The top-of-dashboard search. A collapsible "flap": tap the bar to expand an
 * inline search field, type to see grouped results right here (no navigating
 * away), tap a result to open it. The 📷 button always opens the Scan & Search
 * hub straight into the camera. "Open full search →" hands off to the hub with
 * the current query for the full catalog + scan experience.
 */
const hit = { top: 8, bottom: 8, left: 8, right: 8 };
const PER_GROUP = 3;

export function DashboardSearch() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Vehicle/Locker results open their sheet in place (#122) instead of
  // navigating — the flap stays open behind, so closing the sheet returns to
  // the results. Target persists after close for ModalSheet's exit animation.
  const [infoTarget, setInfoTarget] = useState<{ kind: 'vehicle' | 'locker'; id: string } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  function openInfo(kind: 'vehicle' | 'locker', id: string) {
    setInfoTarget({ kind, id });
    setInfoOpen(true);
  }

  // dataVersion: searchEverything spans many tables — re-run when data changes
  // so results don't go stale while the query text sits unchanged.
  const dataVersion = useDataVersion();
  const results = useMemo(() => searchEverything(query), [query, dataVersion]);
  const hasQuery = query.trim().length > 0;

  function expand() {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }
  function collapse() {
    setOpen(false);
    setQuery('');
  }

  const openScanner = () => { track('action', 'hub_scan', { screen: 'hub' }); router.push({ pathname: '/(app)/(hub)', params: { scan: '1' } }); };
  const openHub = () => router.push({ pathname: '/(app)/(hub)', params: { q: query } });
  const goItem = (id: string) => router.push({ pathname: '/(app)/(inventory)/[id]', params: { id } });
  const goEquipment = (id: string) => router.push({ pathname: '/(app)/(equipment)/[id]', params: { id } });
  const goLocation = (id: string) => router.push({ pathname: '/(app)/(locations)/[id]', params: { id } });
  const goJob = (id: string) => router.push({ pathname: '/(app)/(jobs)/[id]', params: { id } });
  const goUser = () => router.push('/(app)/(admin)/users');

  const total =
    results.items.length + results.equipment.length + results.locations.length +
    results.jobs.length + results.users.length;

  return (
    <View style={s.wrap}>
      <View style={s.barRow}>
        {open ? (
          <View style={s.searchBox}>
            <Text style={s.icon}>🔍</Text>
            <TextInput
              ref={inputRef}
              style={s.input}
              placeholder="Search items, equipment, jobs, people…"
              placeholderTextColor={t.colors.textMuted}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => hasQuery && openHub()}
            />
            <TouchableOpacity onPress={collapse} hitSlop={hit}>
              <Text style={s.chev}>▴</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={s.searchBox} activeOpacity={0.7} onPress={expand}>
            <Text style={s.icon}>🔍</Text>
            <Text style={s.placeholder}>Search items, equipment, jobs, people…</Text>
            <Text style={s.chev}>▾</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={s.cam} onPress={openScanner} accessibilityLabel="Scan a barcode">
          <Text style={s.camIcon}>📷</Text>
        </TouchableOpacity>
      </View>

      {open && hasQuery && (
        <View style={s.results}>
          {total === 0 ? (
            <Text style={s.empty}>No matches.</Text>
          ) : (
            <>
              <Group label="Items" rows={results.items.slice(0, PER_GROUP).map(i => ({
                id: i.id,
                name: i.name,
                sub: i.barcode
                  ? `${i.barcode} · ${formatQuantity(i.total_stock, i.unit, i.unit_category as any)}`
                  : formatQuantity(i.total_stock, i.unit, i.unit_category as any),
                onPress: () => goItem(i.id),
              }))} />
              <Group label="Equipment" rows={results.equipment.slice(0, PER_GROUP).map(e => ({
                id: e.id,
                name: e.name,
                sub: `${e.counts.available} available · ${e.counts.deployed} out`,
                onPress: () => goEquipment(e.id),
              }))} />
              <Group label="Locations" rows={results.locations.slice(0, PER_GROUP).map(l => ({
                id: l.id,
                name: l.name,
                sub: l.type ?? undefined,
                onPress: () => {
                  if (l.type === 'Vehicle') openInfo('vehicle', l.id);
                  else if (l.type === 'Locker') openInfo('locker', l.id);
                  else goLocation(l.id);
                },
              }))} />
              <Group label="Jobs" rows={results.jobs.slice(0, PER_GROUP).map(j => ({
                id: j.id, name: j.name, sub: j.status, onPress: () => goJob(j.id),
              }))} />
              <Group label="People" rows={results.users.slice(0, PER_GROUP).map(u => ({
                id: u.id, name: u.name, sub: u.role, onPress: () => goUser(),
              }))} />
              <TouchableOpacity onPress={openHub}>
                <Text style={s.openAll}>Open full search →</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* In-place quick-view sheets for Vehicle/Locker search results (#122). */}
      {infoTarget?.kind === 'vehicle' && (
        <VehicleSheet locationId={infoTarget.id} visible={infoOpen} onClose={() => setInfoOpen(false)} />
      )}
      {infoTarget?.kind === 'locker' && (
        <LockerSheet locationId={infoTarget.id} visible={infoOpen} onClose={() => setInfoOpen(false)} />
      )}
    </View>
  );
}

function Group({ label, rows }: { label: string; rows: { id: string; name: string; sub?: string; onPress: () => void }[] }) {
  const s = useThemedStyles(makeStyles);
  if (rows.length === 0) return null;
  return (
    <>
      <Text style={s.groupHeader}>{label}</Text>
      {rows.map(r => (
        <TouchableOpacity key={r.id} style={s.row} onPress={r.onPress} activeOpacity={0.7}>
          <View style={{ flex: 1 }}>
            <Text style={s.rowName}>{r.name}</Text>
            {!!r.sub && <Text style={s.rowSub}>{r.sub}</Text>}
          </View>
          <Text style={s.rowChev}>›</Text>
        </TouchableOpacity>
      ))}
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { gap: 8 },
  barRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 12, height: 46,
  },
  icon: { fontSize: 16, marginRight: 8 },
  input: { flex: 1, fontSize: 15, color: t.colors.textPrimary, paddingVertical: 0 },
  placeholder: { flex: 1, fontSize: 15, color: t.colors.textMuted },
  chev: { fontSize: 16, color: t.colors.textSecondary, marginLeft: 8 },
  cam: {
    width: 46, height: 46, borderRadius: 10, backgroundColor: t.colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  camIcon: { fontSize: 20 },
  results: {
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    overflow: 'hidden',
  },
  groupHeader: {
    fontSize: 11, fontWeight: '700', color: t.colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 11,
    borderTopWidth: 1, borderTopColor: t.colors.borderDetail,
  },
  rowName: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: 11, color: t.colors.textMuted, marginTop: 2 },
  rowChev: { fontSize: 20, color: t.colors.textMuted, marginLeft: 8 },
  empty: { padding: 14, color: t.colors.textMuted, textAlign: 'center' },
  openAll: { padding: 12, textAlign: 'center', color: t.colors.primary, fontWeight: '700', fontSize: 14 },
});
