/**
 * Scan & Search Hub — one screen that owns:
 *  - a slide-down global search (SearchFlap) over every entity (searchEverything)
 *  - the catalog list (the old "Manage Catalog") when the search is empty
 *  - a camera-driven continuous scan loop with a small state machine:
 *      browse → scanning → (inout | destination) → receipt
 *  - consumable check-in/out (Task 13/14) and equipment batch checkout (Task 15).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { SearchFlap } from '../../../src/components/hub/SearchFlap';
import { DestinationPicker, type ResolvedDestination } from '../../../src/components/hub/DestinationPicker';
import { InOutSheet } from '../../../src/components/hub/InOutSheet';
import { ScanReceipt, type ScanReceiptEntry } from '../../../src/components/hub/ScanReceipt';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { ItemCard } from '../../../src/components/ItemCard';
import { BarcodeScanner } from '../../../src/components/BarcodeScanner';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { classifyScan, type ScanClass } from '../../../src/scan/scanSession';
import { isHidSupported, connectHidScanner } from '../../../src/scan/hidScanner.web';
import { applyConsumableAction } from '../../../src/scan/stockActions';
import { searchEverything, type GlobalSearchResults } from '../../../src/db/queries/search';
import {
  searchItems, getStockByItem, getStockQuantity, type InventoryItem,
} from '../../../src/db/queries/items';
import { getEquipmentModels, type EquipmentModel } from '../../../src/db/queries/equipment';
import { setUnitStatus, type EquipmentUnit } from '../../../src/db/queries/equipmentUnits';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { generateUUID } from '../../../src/utils/uuid';
import { formatQuantity } from '../../../src/constants/units';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';
import { colors } from '../../../src/theme';

type Mode = 'browse' | 'scanning' | 'inout' | 'destination' | 'receipt';

export default function HubScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { coords, request } = useCurrentPosition();

  // ── Permission gate (Task 13 Step 3) ────────────────────────────────────────
  const canCheckout = usePermission('checkout_inventory');
  const canCheckin = usePermission('checkin_inventory');
  const canAdd = usePermission('add_inventory');
  const canScanAct = canCheckout || canCheckin || canAdd;

  const params = useLocalSearchParams<{ scan?: string; q?: string }>();
  const [mode, setMode] = useState<Mode>('browse');
  const [query, setQuery] = useState('');
  const [flapOpen, setFlapOpen] = useState(false);

  // Deep-link entry points from the dashboard search bar: ?scan=1 jumps straight
  // to the camera; ?q=<text> opens with the flap revealed and the query prefilled.
  useEffect(() => {
    if (params.scan === '1' && canScanAct) setMode('scanning');
    if (params.q) { setQuery(params.q); setFlapOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.scan, params.q]);

  // Consumable in/out working state.
  const [pendingItem, setPendingItem] = useState<InventoryItem | null>(null);
  const [pendingAction, setPendingAction] = useState<{ item: InventoryItem; dir: 'in' | 'out'; qty: number } | null>(null);
  const [needSource, setNeedSource] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceSel, setSourceSel] = useState<PickerOption | null>(null);

  // Equipment batch-checkout accumulator (Task 15).
  const [equipBatch, setEquipBatch] = useState<EquipmentUnit[]>([]);

  // Session receipt.
  const [receipt, setReceipt] = useState<ScanReceiptEntry[]>([]);

  // WebHID scanner (desktop Chrome/Edge only; hidden everywhere else).
  const [hidConnected, setHidConnected] = useState(false);
  const hidDisconnectRef = useRef<(() => void) | null>(null);

  async function connectScanner() {
    try {
      const disconnect = await connectHidScanner(onScan);
      hidDisconnectRef.current = disconnect;
      setHidConnected(true);
    } catch (err) {
      Alert.alert('Scanner', (err as Error).message);
    }
  }

  function disconnectScanner() {
    hidDisconnectRef.current?.();
    hidDisconnectRef.current = null;
    setHidConnected(false);
  }

  // Clean up the HID connection on unmount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => { hidDisconnectRef.current?.(); }, []);

  // Request position once on mount (fire-and-forget; never blocks UI).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void request(); }, []);

  // Catalog (empty-query) list — the "follows the old Manage Catalog" list.
  const catalogItems = useMemo(
    () => searchItems('', 100, 0, undefined, 'product'),
    [],
  );
  const catalogEquipment = useMemo(() => getEquipmentModels(), []);

  // Live grouped search results.
  const results: GlobalSearchResults = useMemo(
    () => searchEverything(query),
    [query],
  );
  const hasQuery = query.trim().length > 0;

  // ── helpers ──────────────────────────────────────────────────────────────
  function resetConsumable() {
    setPendingItem(null);
    setPendingAction(null);
    setNeedSource(false);
    setSourceId(null);
    setSourceSel(null);
  }

  function pushReceiptEntry(entry: ScanReceiptEntry) {
    setReceipt(prev => [...prev, entry]);
  }

  function receiptLabelFor(_dir: 'in' | 'out', dest: ResolvedDestination): string {
    return dest.type === 'job' ? `Job: ${dest.label}` : dest.label;
  }

  function askAnythingElse() {
    Alert.alert('Saved ✓', 'Scan another?', [
      { text: 'Yes', onPress: () => setMode('scanning') },
      { text: 'No', style: 'cancel', onPress: () => setMode('receipt') },
    ]);
  }

  // Outbox a full equipment_units row (mirrors checkout's outboxUnit; synced_at omitted).
  function outboxUnit(u: EquipmentUnit) {
    appendOutbox('INSERT', 'equipment_units', {
      id: u.id, item_id: u.item_id, asset_tag: u.asset_tag,
      serial_number: u.serial_number, status: u.status,
      current_location_id: u.current_location_id, current_job_id: u.current_job_id,
      notes: u.notes, created_at: u.created_at, updated_at: u.updated_at,
      // synced_at intentionally omitted from outbox payload
    });
  }

  // ── scan loop ──────────────────────────────────────────────────────────────
  function onScan(raw: string) {
    const c = classifyScan(raw);
    if (c.kind === 'unknown') { promptAddNewItem(c.code); return; }       // Task 14
    if (c.kind === 'consumable') { setPendingItem(c.item); setMode('inout'); return; }
    // equipment-unit / equipment-model → batch checkout (Task 15)
    enqueueEquipment(c);
  }

  // Closing the scanner: if we've accumulated equipment, go resolve a destination;
  // otherwise return to browse.
  function onScannerClose() {
    if (equipBatch.length > 0) { setMode('destination'); return; }
    setMode('browse');
  }

  // Task 14 — unknown code → verify → add item with prefilled barcode.
  function promptAddNewItem(code: string) {
    setMode('browse');
    Alert.alert(
      'Barcode not recognized',
      `Is this barcode correct?\n\n${code}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add as new item',
          onPress: () =>
            router.push({ pathname: '/(app)/(quickadd)/item', params: { barcode: code } }),
        },
      ],
    );
  }

  // Task 15 Step 1 — accumulate scanned equipment units, reopen the camera.
  function enqueueEquipment(c: ScanClass) {
    if (c.kind === 'equipment-unit') {
      if (c.unit.status === 'available') {
        setEquipBatch(prev => (prev.some(u => u.id === c.unit.id) ? prev : [...prev, c.unit]));
      } else {
        Alert.alert('Not available', `${c.unit.asset_tag} is ${c.unit.status}, not available to check out.`);
      }
    } else if (c.kind === 'equipment-model') {
      Alert.alert('Scan a unit tag', 'Scan the asset tag on the specific unit to check it out.');
    }
    // Immediately reopen the camera for the next scan.
    setMode('scanning');
  }

  // ── consumable in/out ──────────────────────────────────────────────────────
  function onInOutChosen(dir: 'in' | 'out', qty: number) {
    if (!pendingItem) return;
    // Camera actions check the relevant permission before writing.
    if (dir === 'out' && !canCheckout) {
      Alert.alert('Not authorized', 'You don’t have permission to check out inventory.');
      return;
    }
    if (dir === 'in' && !canCheckin) {
      Alert.alert('Not authorized', 'You don’t have permission to check in inventory.');
      return;
    }
    const item = pendingItem;
    let need = false;
    let src: string | null = null;
    if (dir === 'out') {
      const home = item.home_location_id ?? null;
      if (home && getStockQuantity(item.id, home) >= qty) {
        src = home;
      } else {
        need = true;
      }
    }
    setPendingAction({ item, dir, qty });
    setNeedSource(need);
    setSourceId(src);
    setSourceSel(null);
    setMode('destination');
  }

  // Source-location options for the destination step (locations holding stock).
  const sourceOptions: PickerOption[] = useMemo(() => {
    if (!pendingAction) return [];
    const item = pendingAction.item;
    return getStockByItem(item.id)
      .filter(s => s.quantity > 0)
      .map(s => ({
        id: s.location_id,
        label: s.location_name,
        sublabel: formatQuantity(s.quantity, item.unit, item.unit_category as any),
      }));
  }, [pendingAction]);

  function selectSource(opt: PickerOption) {
    setSourceSel(opt);
    setSourceId(opt.id);
  }

  // ── destination resolve (consumable + equipment batch) ──────────────────────
  function onDestResolved(dest: ResolvedDestination | null) {
    if (!dest) return; // incomplete selection

    // Equipment batch path (Task 15 Step 2).
    if (equipBatch.length > 0) { commitEquipmentBatch(dest); return; }

    // Consumable path.
    if (!pendingAction) return;
    const { item, dir, qty } = pendingAction;
    if (dir === 'out' && !sourceId) {
      Alert.alert('Pick a source', 'Choose where this is coming from.');
      return;
    }

    applyConsumableAction({
      itemId: item.id, unit: item.unit, direction: dir, qty,
      sourceLocationId: dir === 'out' ? sourceId : null,
      destLocationId: dest.toLocationId,
      jobId: dest.jobId,
      userId: user?.id ?? null,
      note: dest.type === 'manager' ? `Manager: ${dest.label}` : null,
      coords: coords
        ? { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }
        : undefined,
    });
    pushReceiptEntry({
      id: generateUUID(), itemName: item.name, direction: dir,
      qtyLabel: formatQuantity(qty, item.unit, item.unit_category as any),
      destLabel: receiptLabelFor(dir, dest), at: new Date().toISOString(),
    });
    resetConsumable();
    askAnythingElse();
  }

  // Task 15 Step 2 — commit the batch, mirroring checkout's unit path.
  function commitEquipmentBatch(dest: ResolvedDestination) {
    const baseLog = {
      user_id: user?.id ?? null,
      team_id: null as string | null,
      entity_type: 'item',
      unit: null as string | null,
      metadata: null as string | null,
      device_id: null as string | null,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      location_accuracy: coords?.accuracy ?? null,
    };
    for (const u of equipBatch) {
      if (dest.jobId) {
        const updated = setUnitStatus(u.id, {
          status: 'deployed', current_job_id: dest.jobId, current_location_id: null,
        });
        outboxUnit(updated);
        appendLog({
          ...baseLog, action: 'checkout_to_job', entity_id: u.item_id,
          from_location_id: null, to_location_id: null,
          job_id: dest.jobId, quantity: 1, note: 'unit ' + u.asset_tag,
        });
      } else {
        const updated = setUnitStatus(u.id, {
          status: 'available', current_location_id: dest.toLocationId, current_job_id: null,
        });
        outboxUnit(updated);
        appendLog({
          ...baseLog, action: 'transfer', entity_id: u.item_id,
          from_location_id: null, to_location_id: dest.toLocationId,
          job_id: null, quantity: 1, note: 'unit ' + u.asset_tag,
        });
      }
    }
    const n = equipBatch.length;
    const label = `${n} unit${n > 1 ? 's' : ''}`;
    pushReceiptEntry({
      id: generateUUID(), itemName: label, direction: 'out',
      qtyLabel: label, destLabel: receiptLabelFor('out', dest), at: new Date().toISOString(),
    });
    setEquipBatch([]);
    askAnythingElse();
  }

  // ── search result routing ──────────────────────────────────────────────────
  const goItem = (id: string) => router.push({ pathname: '/(app)/(inventory)/[id]', params: { id } });
  const goEquipment = (id: string) => router.push({ pathname: '/(app)/(equipment)/[id]', params: { id } });
  const goLocation = (id: string) => router.push({ pathname: '/(app)/(locations)/[id]', params: { id } });
  const goJob = (id: string) => router.push({ pathname: '/(app)/(jobs)/[id]', params: { id } });
  const goUser = () => router.push('/(app)/(admin)/users');

  // ── permission gate render ──────────────────────────────────────────────────
  if (!canScanAct) {
    return (
      <>
        <Stack.Screen options={{ title: 'Scan & Search', headerShown: true }} />
        <View style={s.gate}>
          <Text style={s.gateTitle}>Not authorized</Text>
          <Text style={s.gateSub}>
            You don't have permission to scan check-in/out or add inventory. Ask an admin to enable it for your role.
          </Text>
          <PrimaryButton label="Go back" onPress={() => router.back()} style={{ paddingHorizontal: 24 }} />
        </View>
      </>
    );
  }

  // ── scanning (full-screen camera) ───────────────────────────────────────────
  if (mode === 'scanning') {
    return (
      <View style={{ flex: 1 }}>
        <BarcodeScanner active onScanned={onScan} onClose={onScannerClose} />
        {equipBatch.length > 0 && (
          <View style={s.batchBar} pointerEvents="box-none">
            <Text style={s.batchCount}>{equipBatch.length} unit{equipBatch.length > 1 ? 's' : ''} queued</Text>
            <TouchableOpacity style={s.batchDone} onPress={() => setMode('destination')}>
              <Text style={s.batchDoneText}>Done scanning →</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  // ── receipt ──────────────────────────────────────────────────────────────────
  if (mode === 'receipt') {
    return (
      <>
        <Stack.Screen options={{ title: 'Scan & Search', headerShown: true }} />
        <ScanReceipt
          entries={receipt}
          onAddMore={() => setMode('scanning')}
          onDone={() => router.replace('/(app)/(dashboard)')}
        />
      </>
    );
  }

  // ── browse / inout / destination (shared browse body + overlays) ─────────────
  const destItem = pendingAction?.item ?? null;

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Scan & Search',
          headerShown: true,
          headerRight: () => (
            <TouchableOpacity
              style={s.headerScan}
              onPress={() => setMode('scanning')}
              accessibilityLabel="Scan a barcode"
            >
              <Text style={s.headerScanIcon}>📷</Text>
            </TouchableOpacity>
          ),
        }}
      />
      <View style={s.container}>
        <SearchFlap
          value={query}
          onChangeText={setQuery}
          open={flapOpen}
          onToggle={() => setFlapOpen(o => !o)}
        />
        {isHidSupported() && (
          <TouchableOpacity
            style={s.hidButton}
            onPress={hidConnected ? disconnectScanner : connectScanner}
            accessibilityLabel="Connect a USB barcode scanner"
          >
            <Text style={s.hidButtonText}>
              {hidConnected ? '✓ Scanner connected — tap to disconnect' : '🔌 Connect scanner'}
            </Text>
          </TouchableOpacity>
        )}
        <ScrollView
          style={s.list}
          contentContainerStyle={s.listContent}
          keyboardShouldPersistTaps="handled"
        >
          {hasQuery ? (
            <SearchResults
              results={results}
              onItem={goItem}
              onEquipment={goEquipment}
              onLocation={goLocation}
              onJob={goJob}
              onUser={goUser}
            />
          ) : (
            <View style={{ gap: 10 }}>
              {catalogItems.map(item => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onCheckout={(itemId) => router.push({ pathname: '/(app)/(checkout)', params: { itemId } })}
                />
              ))}
              {catalogEquipment.length > 0 && (
                <>
                  <Text style={s.sectionHeader}>Equipment</Text>
                  {catalogEquipment.map(eq => (
                    <ResultRow
                      key={eq.id}
                      label={eq.name}
                      sub={`${eq.counts.available} available · ${eq.counts.deployed} out`}
                      onPress={() => goEquipment(eq.id)}
                    />
                  ))}
                </>
              )}
              {catalogItems.length === 0 && catalogEquipment.length === 0 && (
                <Text style={s.empty}>No catalog items yet.</Text>
              )}
            </View>
          )}
        </ScrollView>
      </View>

      {/* Consumable: Check In / Check Out + qty */}
      <InOutSheet
        visible={mode === 'inout'}
        item={pendingItem}
        onChoose={onInOutChosen}
        onClose={() => { resetConsumable(); setMode('browse'); }}
      />

      {/* Destination resolve (consumable + equipment batch) */}
      <ModalSheet
        visible={mode === 'destination'}
        onClose={() => { resetConsumable(); setEquipBatch([]); setMode('browse'); }}
      >
        {equipBatch.length > 0 ? (
          <Text style={s.sheetTitle}>
            {equipBatch.length} unit{equipBatch.length > 1 ? 's' : ''} → where to?
          </Text>
        ) : destItem && pendingAction ? (
          <Text style={s.sheetTitle}>
            {pendingAction.dir === 'out' ? 'Check Out' : 'Check In'} {formatQuantity(pendingAction.qty, destItem.unit, destItem.unit_category as any)} · {destItem.name}
          </Text>
        ) : null}

        {/* Source picker (consumable out without a usable home location) */}
        {equipBatch.length === 0 && needSource && pendingAction?.dir === 'out' && (
          <View style={{ marginBottom: 8 }}>
            <Text style={s.label}>Source</Text>
            {sourceOptions.length === 0 ? (
              <Text style={s.empty}>No stock available for this item.</Text>
            ) : (
              <SearchablePicker
                placeholder="Search source location..."
                options={sourceOptions}
                value={sourceSel}
                onSelect={selectSource}
              />
            )}
          </View>
        )}

        <DestinationPicker onResolved={onDestResolved} />
      </ModalSheet>
    </>
  );
}

// ── grouped search results ─────────────────────────────────────────────────────
function SearchResults({
  results, onItem, onEquipment, onLocation, onJob, onUser,
}: {
  results: GlobalSearchResults;
  onItem: (id: string) => void;
  onEquipment: (id: string) => void;
  onLocation: (id: string) => void;
  onJob: (id: string) => void;
  onUser: (id: string) => void;
}) {
  const total =
    results.items.length + results.equipment.length + results.locations.length +
    results.jobs.length + results.users.length;
  if (total === 0) return <Text style={s.empty}>No matches.</Text>;

  return (
    <View style={{ gap: 6 }}>
      {results.items.length > 0 && <Text style={s.sectionHeader}>Items</Text>}
      {results.items.map(i => (
        <ResultRow
          key={i.id}
          label={i.name}
          sub={i.barcode ? `${i.barcode} · ${formatQuantity(i.total_stock, i.unit, i.unit_category as any)}` : formatQuantity(i.total_stock, i.unit, i.unit_category as any)}
          onPress={() => onItem(i.id)}
        />
      ))}

      {results.equipment.length > 0 && <Text style={s.sectionHeader}>Equipment</Text>}
      {results.equipment.map((e: EquipmentModel) => (
        <ResultRow
          key={e.id}
          label={e.name}
          sub={`${e.counts.available} available · ${e.counts.deployed} out`}
          onPress={() => onEquipment(e.id)}
        />
      ))}

      {results.locations.length > 0 && <Text style={s.sectionHeader}>Locations</Text>}
      {results.locations.map(l => (
        <ResultRow key={l.id} label={l.name} onPress={() => onLocation(l.id)} />
      ))}

      {results.jobs.length > 0 && <Text style={s.sectionHeader}>Jobs</Text>}
      {results.jobs.map(j => (
        <ResultRow key={j.id} label={j.name} sub={j.status} onPress={() => onJob(j.id)} />
      ))}

      {results.users.length > 0 && <Text style={s.sectionHeader}>People</Text>}
      {results.users.map(u => (
        <ResultRow key={u.id} label={u.name} sub={u.role} onPress={() => onUser(u.id)} />
      ))}
    </View>
  );
}

function ResultRow({ label, sub, onPress }: { label: string; sub?: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.row} onPress={onPress} activeOpacity={0.7}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowName}>{label}</Text>
        {!!sub && <Text style={s.rowSub}>{sub}</Text>}
      </View>
      <Text style={s.rowChevron}>›</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 80 },
  sectionHeader: {
    fontSize: 13, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, padding: 14,
    borderRadius: 10, borderWidth: 1, borderColor: colors.border,
  },
  rowName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowChevron: { fontSize: 22, color: colors.textMuted, marginLeft: 8 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: 24 },
  label: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 6 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  headerScan: { paddingHorizontal: 8, paddingVertical: 4 },
  headerScanIcon: { fontSize: 22 },
  hidButton: {
    marginHorizontal: 12, marginTop: 10, paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    alignItems: 'center',
  },
  hidButtonText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  batchBar: {
    position: 'absolute', bottom: 40, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  batchCount: {
    color: '#fff', fontSize: 15, fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
    overflow: 'hidden',
  },
  batchDone: {
    backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8,
  },
  batchDoneText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: colors.background },
  gateTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  gateSub: { fontSize: 15, color: colors.textSecondary, textAlign: 'center', marginBottom: 24 },
});
