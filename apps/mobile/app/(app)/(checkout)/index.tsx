/**
 * Checkout wizard — 4 steps:
 * 1. find    — find the item (search list or arrive with itemId param from scan)
 * 2. qty     — pick source location + quantity
 * 3. dest    — choose a destination: Job / Location / Production Manager
 * 4. confirm — review the resolved destination(s) and run the stock writes
 */
import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import {
  searchItems, getItemById, getStockByItem, adjustStock, getStockQuantity,
  type ItemWithTotalStock, type StockByLocation,
} from '../../../src/db/queries/items';
import { getOpenJobs, upsertJob, type Job } from '../../../src/db/queries/jobs';
import { getAllLocations, getLocationsByOwner, type Location } from '../../../src/db/queries/locations';
import { getUsersByRole } from '../../../src/db/queries/users';
import { useSession } from '../../../src/hooks/useSession';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { generateUUID } from '../../../src/utils/uuid';
import { formatQuantity } from '../../../src/constants/units';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';

type Step = 'find' | 'qty' | 'dest' | 'confirm';
type DestType = 'job' | 'location' | 'pm';
type PmMode = 'single' | 'multiple';

// One production-manager target: who, which of their locations, how much.
interface PmSelection {
  pmId: string;
  pmName: string;
  locationId: string | null;
  locationName: string | null;
  qty: string;
}

export default function CheckoutScreen() {
  const router = useRouter();
  const { user } = useSession();
  const params = useLocalSearchParams<{ itemId?: string }>();

  const [step, setStep] = useState<Step>('find');
  const [itemSearch, setItemSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<ItemWithTotalStock | null>(null);
  const [stock, setStock] = useState<StockByLocation[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<StockByLocation | null>(null);
  const [quantity, setQuantity] = useState('1');

  // Destination
  const [destType, setDestType] = useState<DestType | null>(null);
  const [selectedJob, setSelectedJob] = useState<{ id: string; name: string } | null>(null);
  const [selectedDestLocation, setSelectedDestLocation] = useState<Location | null>(null);
  const [pmMode, setPmMode] = useState<PmMode>('single');
  const [pmSelections, setPmSelections] = useState<PmSelection[]>([]);

  const [submitting, setSubmitting] = useState(false);

  // If navigated with itemId param (from a scan), skip straight to qty.
  useEffect(() => {
    if (params.itemId) {
      const item = getItemById(params.itemId) as ItemWithTotalStock | null;
      if (item) handleSelectItem(item);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.itemId]);

  const itemResults = useMemo(() => {
    if (!itemSearch.trim()) return [];
    return searchItems(itemSearch, 50, 0);
  }, [itemSearch]);

  const cat = (selectedItem?.unit_category ?? '') as any;
  const unit = selectedItem?.unit ?? '';

  // Source-location options for the qty step (only locations that hold stock).
  const sourceOptions: PickerOption[] = useMemo(
    () => stock.map(s => ({
      id: s.location_id,
      label: s.location_name,
      sublabel: [s.parent_name, formatQuantity(s.quantity, unit, cat)].filter(Boolean).join(' · '),
    })),
    [stock, unit, cat]
  );
  const sourceValue: PickerOption | null = selectedLocation
    ? { id: selectedLocation.location_id, label: selectedLocation.location_name }
    : null;

  // Destination-location options (all locations except the source).
  const allLocations = useMemo(() => getAllLocations(), []);
  const locNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of allLocations) m.set(l.id, l.name);
    return m;
  }, [allLocations]);
  const destLocationOptions: PickerOption[] = useMemo(
    () => allLocations
      .filter(l => l.id !== selectedLocation?.location_id)
      .map(l => ({
        id: l.id,
        label: l.name,
        sublabel: l.parent_id ? (locNameById.get(l.parent_id) ?? undefined) : undefined,
      })),
    [allLocations, selectedLocation, locNameById]
  );
  const destLocationValue: PickerOption | null = selectedDestLocation
    ? { id: selectedDestLocation.id, label: selectedDestLocation.name }
    : null;

  // Job options (open jobs; SearchablePicker filters client-side, onCreate makes new).
  const jobOptions: PickerOption[] = useMemo(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    // recompute when we land on dest so a freshly-created job appears
    [step]
  );
  const jobValue: PickerOption | null = selectedJob
    ? { id: selectedJob.id, label: selectedJob.name }
    : null;

  // Production managers.
  const pms = useMemo(() => getUsersByRole('production_manager'), []);
  const pmOptions: PickerOption[] = useMemo(() => pms.map(u => ({ id: u.id, label: u.name })), [pms]);

  function handleSelectItem(item: ItemWithTotalStock) {
    setSelectedItem(item);
    const stockRows = getStockByItem(item.id).filter(s => s.quantity > 0);
    setStock(stockRows);
    setSelectedLocation(null);
    setQuantity('1');
    resetDest();
    setStep('qty');
  }

  function resetDest() {
    setDestType(null);
    setSelectedJob(null);
    setSelectedDestLocation(null);
    setPmMode('single');
    setPmSelections([]);
  }

  // ── Source location ──────────────────────────────────────────────────────
  function selectSource(opt: PickerOption) {
    if (selectedLocation?.location_id === opt.id) { setSelectedLocation(null); return; }
    setSelectedLocation(stock.find(s => s.location_id === opt.id) ?? null);
  }

  // ── Destination: job ─────────────────────────────────────────────────────
  function selectJob(opt: PickerOption) {
    if (selectedJob?.id === opt.id) { setSelectedJob(null); return; }
    setSelectedJob({ id: opt.id, name: opt.label });
  }
  function createJob(text: string) {
    if (!user) return;
    const now = new Date().toISOString();
    const newJob: Job = {
      id: generateUUID(), name: text, status: 'open',
      created_by: user.id, created_at: now, updated_at: now, synced_at: null,
    };
    upsertJob(newJob);
    appendOutbox('INSERT', 'jobs', { ...newJob });
    setSelectedJob({ id: newJob.id, name: newJob.name });
  }

  // ── Destination: location ────────────────────────────────────────────────
  function selectDestLocation(opt: PickerOption) {
    if (selectedDestLocation?.id === opt.id) { setSelectedDestLocation(null); return; }
    setSelectedDestLocation(allLocations.find(l => l.id === opt.id) ?? null);
  }

  // ── Destination: production manager ──────────────────────────────────────
  function setMode(mode: PmMode) {
    setPmMode(mode);
    setPmSelections([]);
  }
  function selectSinglePm(opt: PickerOption) {
    if (pmSelections[0]?.pmId === opt.id) { setPmSelections([]); return; }
    const locs = getLocationsByOwner(opt.id);
    const one = locs.length === 1 ? locs[0] : null;
    setPmSelections([{
      pmId: opt.id, pmName: opt.label,
      locationId: one?.id ?? null, locationName: one?.name ?? null,
      qty: quantity, // single PM gets the step quantity
    }]);
  }
  function toggleMultiPm(opt: PickerOption) {
    setPmSelections(prev => {
      if (prev.some(p => p.pmId === opt.id)) return prev.filter(p => p.pmId !== opt.id);
      const locs = getLocationsByOwner(opt.id);
      const one = locs.length === 1 ? locs[0] : null;
      return [...prev, {
        pmId: opt.id, pmName: opt.label,
        locationId: one?.id ?? null, locationName: one?.name ?? null,
        qty: '1',
      }];
    });
  }
  function setPmLocation(pmId: string, loc: Location | null) {
    setPmSelections(prev => prev.map(p =>
      p.pmId === pmId ? { ...p, locationId: loc?.id ?? null, locationName: loc?.name ?? null } : p
    ));
  }
  function setPmQty(pmId: string, qty: string) {
    setPmSelections(prev => prev.map(p => (p.pmId === pmId ? { ...p, qty } : p)));
  }

  // Whether the dest step is complete enough to review.
  const destReady = useMemo(() => {
    if (destType === 'job') return !!selectedJob;
    if (destType === 'location') return !!selectedDestLocation;
    if (destType === 'pm') {
      return pmSelections.length > 0 &&
        pmSelections.every(p => p.locationId && (parseFloat(p.qty) || 0) > 0);
    }
    return false;
  }, [destType, selectedJob, selectedDestLocation, pmSelections]);

  // ── Stock write helper: deduct source, optionally credit a destination. ───
  // Both outbox rows carry the ABSOLUTE post-adjust on-hand (never a delta).
  function stockMove(itemId: string, fromLoc: string, toLoc: string | null, qty: number) {
    adjustStock(itemId, fromLoc, -qty);
    appendOutbox('INSERT', 'stock_by_location', {
      item_id: itemId, location_id: fromLoc,
      quantity: getStockQuantity(itemId, fromLoc),
      updated_at: new Date().toISOString(),
    });
    if (toLoc) {
      adjustStock(itemId, toLoc, qty);
      appendOutbox('INSERT', 'stock_by_location', {
        item_id: itemId, location_id: toLoc,
        quantity: getStockQuantity(itemId, toLoc),
        updated_at: new Date().toISOString(),
      });
    }
  }

  async function handleConfirm() {
    if (!selectedItem || !selectedLocation || !user || !destType) return;
    const itemId = selectedItem.id;
    const source = selectedLocation.location_id;
    const onHand = getStockQuantity(itemId, source);
    const baseLog = {
      user_id: user.id,
      team_id: null as string | null,
      entity_type: 'item',
      entity_id: itemId,
      unit: selectedItem.unit,
      device_id: null as string | null,
      metadata: null as string | null,
    };

    if (destType === 'job') {
      const qty = parseFloat(quantity);
      if (!selectedJob) { Alert.alert('Pick a Job', 'Choose or create a job first.'); return; }
      if (isNaN(qty) || qty <= 0) { Alert.alert('Invalid Quantity', 'Enter a positive number.'); return; }
      if (qty > onHand) { Alert.alert('Not Enough Stock', `Only ${formatQuantity(onHand, unit, cat)} available.`); return; }

      // Returnable items stay outstanding (surfaces in Check In); non-returnable
      // items are consumed — stock deducted, does NOT appear in Check In.
      const returnable = !!getItemById(itemId)?.returnable;
      const logAction = returnable ? 'checkout_to_job' : 'consumed';

      setSubmitting(true);
      stockMove(itemId, source, null, qty);
      appendLog({
        ...baseLog, action: logAction,
        from_location_id: source, to_location_id: null,
        job_id: selectedJob.id, quantity: qty, note: null,
      });
      done(returnable
        ? `${formatQuantity(qty, unit, cat)} of ${selectedItem.name} checked out to ${selectedJob.name}.`
        : `${formatQuantity(qty, unit, cat)} of ${selectedItem.name} consumed for ${selectedJob.name}.`);
      return;
    }

    if (destType === 'location') {
      const qty = parseFloat(quantity);
      if (!selectedDestLocation) { Alert.alert('Pick a Location', 'Choose a destination location.'); return; }
      if (isNaN(qty) || qty <= 0) { Alert.alert('Invalid Quantity', 'Enter a positive number.'); return; }
      if (qty > onHand) { Alert.alert('Not Enough Stock', `Only ${formatQuantity(onHand, unit, cat)} available.`); return; }

      setSubmitting(true);
      stockMove(itemId, source, selectedDestLocation.id, qty);
      appendLog({
        ...baseLog, action: 'transfer',
        from_location_id: source, to_location_id: selectedDestLocation.id,
        job_id: null, quantity: qty, note: null,
      });
      done(`Transferred ${formatQuantity(qty, unit, cat)} of ${selectedItem.name} to ${selectedDestLocation.name}.`);
      return;
    }

    // destType === 'pm'
    const targets = pmSelections.map(p => ({
      pmName: p.pmName, locationId: p.locationId, qty: parseFloat(p.qty),
    }));
    if (targets.length === 0) { Alert.alert('Pick a Manager', 'Select at least one production manager.'); return; }
    if (targets.some(t => !t.locationId)) { Alert.alert('Pick a Location', 'Each manager needs a destination location.'); return; }
    if (targets.some(t => isNaN(t.qty) || t.qty <= 0)) { Alert.alert('Invalid Quantity', 'Each manager needs a positive quantity.'); return; }
    const totalQty = targets.reduce((sum, t) => sum + t.qty, 0);
    if (totalQty > onHand) {
      Alert.alert('Not Enough Stock', `Total requested (${formatQuantity(totalQty, unit, cat)}) exceeds the ${formatQuantity(onHand, unit, cat)} on hand.`);
      return;
    }

    setSubmitting(true);
    for (const t of targets) {
      stockMove(itemId, source, t.locationId!, t.qty);
      appendLog({
        ...baseLog, action: 'transfer',
        from_location_id: source, to_location_id: t.locationId!,
        job_id: null, quantity: t.qty, note: `PM: ${t.pmName}`,
      });
    }
    done(`${formatQuantity(totalQty, unit, cat)} of ${selectedItem.name} checked out to ${targets.length} manager${targets.length > 1 ? 's' : ''}.`);
  }

  function done(message: string) {
    setSubmitting(false);
    Alert.alert('Done ✓', message, [
      { text: 'Done', onPress: () => router.replace('/(app)/(dashboard)') },
    ]);
  }

  // ── find ─────────────────────────────────────────────────────────────────
  if (step === 'find') {
    return (
      <>
        <Stack.Screen options={{ title: 'Check Out Item', headerShown: true }} />
        <View style={s.container}>
          <TextInput
            style={s.input}
            placeholder="Search item name or barcode..."
            value={itemSearch}
            onChangeText={setItemSearch}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity style={s.scanRow} onPress={() => router.push('/(app)/(inventory)/scan')}>
            <Text style={s.scanText}>⬛  Scan Barcode Instead</Text>
          </TouchableOpacity>
          <FlatList
            data={itemResults}
            keyExtractor={i => i.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.row} onPress={() => handleSelectItem(item)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName}>{item.name}</Text>
                  {item.barcode && <Text style={s.rowSub}>{item.barcode}</Text>}
                </View>
                <Text style={s.rowStock}>{formatQuantity(item.total_stock, item.unit, item.unit_category as any)}</Text>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={s.sep} />}
            ListEmptyComponent={
              itemSearch.length > 0
                ? <Text style={s.empty}>No items found</Text>
                : <Text style={s.empty}>Type to search inventory</Text>
            }
          />
        </View>
      </>
    );
  }

  // ── qty ──────────────────────────────────────────────────────────────────
  if (step === 'qty' && selectedItem) {
    return (
      <>
        <Stack.Screen options={{ title: 'Select Location & Qty', headerShown: true }} />
        <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Text style={s.sectionLabel}>{selectedItem.name}</Text>

          <Text style={s.label}>Source Location</Text>
          {stock.length === 0 ? (
            <Text style={s.empty}>No stock available</Text>
          ) : (
            <SearchablePicker
              placeholder="Search source location..."
              options={sourceOptions}
              value={sourceValue}
              onSelect={selectSource}
            />
          )}

          <Text style={s.label}>Quantity</Text>
          <TextInput
            style={s.qtyInput}
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="decimal-pad"
            selectTextOnFocus
          />

          <TouchableOpacity
            style={[s.btn, !selectedLocation && s.btnDisabled]}
            disabled={!selectedLocation}
            onPress={() => { resetDest(); setStep('dest'); }}
          >
            <Text style={s.btnText}>Next: Choose Destination →</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </>
    );
  }

  // ── dest ─────────────────────────────────────────────────────────────────
  if (step === 'dest' && selectedItem && selectedLocation) {
    return (
      <>
        <Stack.Screen options={{ title: 'Destination', headerShown: true }} />
        <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            <Text style={s.sectionLabel}>
              {formatQuantity(parseFloat(quantity) || 0, unit, cat)} · {selectedItem.name}
            </Text>

            <Text style={s.label}>Destination Type</Text>
            <View style={s.forRow}>
              {(['job', 'location', 'pm'] as const).map(opt => (
                <TouchableOpacity
                  key={opt}
                  style={[s.forBtn, destType === opt && s.forBtnActive]}
                  onPress={() => { resetDest(); setDestType(opt); }}
                >
                  <Text style={[s.forBtnText, destType === opt && s.forBtnTextActive]}>
                    {opt === 'job' ? 'Job' : opt === 'location' ? 'Location' : 'Manager'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {destType === 'job' && (
              <>
                <Text style={s.label}>Job</Text>
                <SearchablePicker
                  placeholder="Search or create a job..."
                  options={jobOptions}
                  value={jobValue}
                  onSelect={selectJob}
                  onCreate={createJob}
                />
              </>
            )}

            {destType === 'location' && (
              <>
                <Text style={s.label}>To Location</Text>
                <SearchablePicker
                  placeholder="Search destination location..."
                  options={destLocationOptions}
                  value={destLocationValue}
                  onSelect={selectDestLocation}
                />
              </>
            )}

            {destType === 'pm' && (
              <>
                <Text style={s.label}>Managers</Text>
                <View style={s.forRow}>
                  {(['single', 'multiple'] as const).map(m => (
                    <TouchableOpacity
                      key={m}
                      style={[s.forBtn, pmMode === m && s.forBtnActive]}
                      onPress={() => setMode(m)}
                    >
                      <Text style={[s.forBtnText, pmMode === m && s.forBtnTextActive]}>
                        {m === 'single' ? 'Single' : 'Multiple'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {pms.length === 0 && <Text style={s.empty}>No production managers found</Text>}

                {pmMode === 'single' ? (
                  <View style={{ marginTop: 8 }}>
                    <SearchablePicker
                      placeholder="Pick a production manager..."
                      options={pmOptions}
                      value={pmSelections[0] ? { id: pmSelections[0].pmId, label: pmSelections[0].pmName } : null}
                      onSelect={selectSinglePm}
                    />
                    {pmSelections[0] && (
                      <PmLocationRow
                        sel={pmSelections[0]}
                        onPick={loc => setPmLocation(pmSelections[0].pmId, loc)}
                        qtyEditable={false}
                        qtyDisplay={formatQuantity(parseFloat(quantity) || 0, unit, cat)}
                      />
                    )}
                  </View>
                ) : (
                  <View style={{ marginTop: 8 }}>
                    {pmOptions.map(opt => {
                      const sel = pmSelections.find(p => p.pmId === opt.id);
                      return (
                        <View key={opt.id}>
                          <TouchableOpacity
                            style={[s.row, sel && s.rowSelected]}
                            onPress={() => toggleMultiPm(opt)}
                          >
                            <Text style={s.rowName}>{opt.label}</Text>
                            <Text style={s.rowStock}>{sel ? '✓' : ''}</Text>
                          </TouchableOpacity>
                          {sel && (
                            <PmLocationRow
                              sel={sel}
                              onPick={loc => setPmLocation(sel.pmId, loc)}
                              qtyEditable
                              qtyValue={sel.qty}
                              onQtyChange={q => setPmQty(sel.pmId, q)}
                            />
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            )}

            <TouchableOpacity
              style={[s.btn, !destReady && s.btnDisabled]}
              disabled={!destReady}
              onPress={() => setStep('confirm')}
            >
              <Text style={s.btnText}>Review →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.btnSecondary} onPress={() => setStep('qty')}>
              <Text style={s.btnSecondaryText}>← Go Back</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </>
    );
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  const fromLabel = [selectedLocation?.parent_name, selectedLocation?.location_name].filter(Boolean).join(' › ');
  return (
    <>
      <Stack.Screen options={{ title: 'Confirm', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.confirmContent}>
        <Text style={s.confirmTitle}>Review & Confirm</Text>

        <View style={s.confirmCard}>
          <Row label="Item" value={selectedItem?.name ?? ''} />
          <Row label="From" value={fromLabel} />
          {destType === 'job' && (
            <>
              <Row label="Qty" value={formatQuantity(parseFloat(quantity) || 0, unit, cat)} />
              <Row label="To Job" value={selectedJob?.name ?? ''} />
              <Row
                label="Action"
                value={selectedItem && !!selectedItem.returnable ? 'Deploy (returnable)' : 'Consume'}
              />
            </>
          )}
          {destType === 'location' && (
            <>
              <Row label="Qty" value={formatQuantity(parseFloat(quantity) || 0, unit, cat)} />
              <Row label="To Location" value={selectedDestLocation?.name ?? ''} />
            </>
          )}
          {destType === 'pm' && pmSelections.map(p => (
            <Row
              key={p.pmId}
              label={p.pmName}
              value={`${formatQuantity(parseFloat(p.qty) || 0, unit, cat)} → ${p.locationName ?? '?'}`}
            />
          ))}
        </View>

        <TouchableOpacity style={s.btn} disabled={submitting} onPress={handleConfirm}>
          <Text style={s.btnText}>{submitting ? 'Working...' : 'Confirm ✓'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btnSecondary} onPress={() => setStep('dest')}>
          <Text style={s.btnSecondaryText}>← Go Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

// Per-PM location picker (+ optional per-PM quantity for the multiple case).
function PmLocationRow({
  sel, onPick, qtyEditable, qtyValue, onQtyChange, qtyDisplay,
}: {
  sel: PmSelection;
  onPick: (loc: Location | null) => void;
  qtyEditable: boolean;
  qtyValue?: string;
  onQtyChange?: (q: string) => void;
  qtyDisplay?: string;
}) {
  const locs = useMemo(() => getLocationsByOwner(sel.pmId), [sel.pmId]);
  const options: PickerOption[] = locs.map(l => ({ id: l.id, label: l.name }));
  const value: PickerOption | null = sel.locationId
    ? { id: sel.locationId, label: sel.locationName ?? '' }
    : null;
  return (
    <View style={s.pmDetail}>
      {locs.length === 1 ? (
        <Text style={s.pmHint}>Location: {sel.locationName}</Text>
      ) : (
        <SearchablePicker
          placeholder="Pick this manager's location..."
          options={options}
          value={value}
          onSelect={opt => onPick(sel.locationId === opt.id ? null : (locs.find(l => l.id === opt.id) ?? null))}
        />
      )}
      {qtyEditable ? (
        <View style={s.pmQtyRow}>
          <Text style={s.pmHint}>Qty</Text>
          <TextInput
            style={s.pmQtyInput}
            value={qtyValue}
            onChangeText={onQtyChange}
            keyboardType="decimal-pad"
            selectTextOnFocus
          />
        </View>
      ) : (
        <Text style={s.pmHint}>Qty: {qtyDisplay}</Text>
      )}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.confirmRow}>
      <Text style={s.confirmLabel}>{label}</Text>
      <Text style={s.confirmValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF', padding: 16 },
  confirmContent: { padding: 16, gap: 16 },
  sectionLabel: { fontSize: 18, fontWeight: '700', color: '#1E3A5F', marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 15, color: '#1E293B',
  },
  qtyInput: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 54, fontSize: 24, fontWeight: '700',
    color: '#1E293B', textAlign: 'center',
  },
  scanRow: { paddingVertical: 12, alignItems: 'center' },
  scanText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', padding: 14,
    borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', marginBottom: 6,
  },
  rowSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  rowName: { fontSize: 15, fontWeight: '600', color: '#1E293B', flex: 1 },
  rowSub: { fontSize: 11, color: '#94A3B8' },
  rowStock: { fontSize: 14, fontWeight: '600', color: '#16A34A' },
  sep: { height: 1, backgroundColor: '#F1F5F9' },
  empty: { textAlign: 'center', color: '#94A3B8', marginTop: 20 },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 14,
    alignItems: 'center', marginTop: 20,
  },
  btnDisabled: { backgroundColor: '#93C5FD' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnSecondary: { alignItems: 'center', paddingVertical: 10 },
  btnSecondaryText: { color: '#64748B', fontSize: 15 },
  forRow: { flexDirection: 'row', gap: 8 },
  forBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    backgroundColor: '#F1F5F9', alignItems: 'center',
  },
  forBtnActive: { backgroundColor: '#DBEAFE' },
  forBtnText: { fontSize: 14, color: '#64748B', fontWeight: '600' },
  forBtnTextActive: { color: '#1D4ED8' },
  pmDetail: { marginBottom: 10, paddingLeft: 8, gap: 6 },
  pmHint: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  pmQtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pmQtyInput: {
    backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 12, height: 40, fontSize: 16, fontWeight: '700',
    color: '#1E293B', textAlign: 'center', minWidth: 80,
  },
  confirmTitle: { fontSize: 22, fontWeight: '700', color: '#1E3A5F' },
  confirmCard: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1,
    borderColor: '#E2E8F0', padding: 16, gap: 12,
  },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between' },
  confirmLabel: { fontSize: 14, color: '#64748B' },
  confirmValue: { fontSize: 14, fontWeight: '600', color: '#1E293B', flex: 1, textAlign: 'right' },
});
