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
import {
  getUnitsForItem, getAvailableUnitsAtLocation, getUnitByTag, setUnitStatus,
  type EquipmentUnit,
} from '../../../src/db/queries/equipmentUnits';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { generateUUID } from '../../../src/utils/uuid';
import { formatQuantity } from '../../../src/constants/units';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { BarcodeInput } from '../../../src/components/BarcodeInput';

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

  // Unit-tracked items move SPECIFIC units instead of a quantity.
  const [selectedUnits, setSelectedUnits] = useState<EquipmentUnit[]>([]);
  const [scanTag, setScanTag] = useState('');

  // Destination
  const [destType, setDestType] = useState<DestType | null>(null);
  const [selectedJob, setSelectedJob] = useState<{ id: string; name: string } | null>(null);
  const [selectedDestLocation, setSelectedDestLocation] = useState<Location | null>(null);
  const [pmMode, setPmMode] = useState<PmMode>('single');
  const [pmSelections, setPmSelections] = useState<PmSelection[]>([]);

  const [submitting, setSubmitting] = useState(false);

  // Permission gates
  const canCreateJobs = usePermission('create_jobs');
  const canUploadMedia = usePermission('upload_media');
  // Stable UUID for the checkout event; refreshed each time we enter the confirm step
  const [checkoutEventId, setCheckoutEventId] = useState<string>(() => generateUUID());

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
  const isUnitTracked = !!selectedItem?.unit_tracked;

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
  const locById = useMemo(() => {
    const m = new Map<string, Location>();
    for (const l of allLocations) m.set(l.id, l);
    return m;
  }, [allLocations]);

  // For unit-tracked items there are no stock_by_location rows, so the source
  // picker is derived from the locations where AVAILABLE units currently sit.
  const availableUnits = useMemo(() => {
    if (!selectedItem || !isUnitTracked || !selectedLocation) return [];
    return getAvailableUnitsAtLocation(selectedItem.id, selectedLocation.location_id);
  }, [selectedItem, isUnitTracked, selectedLocation]);
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

  // Build source-location rows for a unit-tracked item from its available units
  // (count of available units per location), so the existing source picker works.
  function buildUnitSourceStock(itemId: string): StockByLocation[] {
    const units = getUnitsForItem(itemId)
      .filter(u => u.status === 'available' && u.current_location_id);
    const byLoc = new Map<string, number>();
    for (const u of units) {
      const loc = u.current_location_id!;
      byLoc.set(loc, (byLoc.get(loc) ?? 0) + 1);
    }
    const rows: StockByLocation[] = [];
    for (const [locId, count] of byLoc) {
      const loc = locById.get(locId);
      rows.push({
        location_id: locId,
        location_name: loc?.name ?? locId,
        parent_id: loc?.parent_id ?? null,
        parent_name: loc?.parent_id ? (locNameById.get(loc.parent_id) ?? null) : null,
        quantity: count,
      });
    }
    rows.sort((a, b) => a.location_name.localeCompare(b.location_name));
    return rows;
  }

  function handleSelectItem(item: ItemWithTotalStock) {
    setSelectedItem(item);
    const stockRows = item.unit_tracked
      ? buildUnitSourceStock(item.id)
      : getStockByItem(item.id).filter(s => s.quantity > 0);
    setStock(stockRows);
    setSelectedLocation(null);
    setSelectedUnits([]);
    setScanTag('');
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
    setSelectedUnits([]); // changing source invalidates any unit selection
    if (selectedLocation?.location_id === opt.id) { setSelectedLocation(null); return; }
    setSelectedLocation(stock.find(s => s.location_id === opt.id) ?? null);
  }

  // ── Unit selection (unit-tracked items only) ─────────────────────────────
  function toggleUnit(u: EquipmentUnit) {
    setSelectedUnits(prev =>
      prev.some(x => x.id === u.id) ? prev.filter(x => x.id !== u.id) : [...prev, u]);
  }
  function addUnitByTag(tag: string) {
    const t = tag.trim();
    if (!t) return;
    if (!selectedItem || !selectedLocation) { Alert.alert('Pick a Source', 'Choose a source location first.'); return; }
    const u = getUnitByTag(t);
    if (!u) { Alert.alert('Unknown Tag', `No unit found for "${t}".`); return; }
    if (u.item_id !== selectedItem.id) { Alert.alert('Wrong Item', `Tag "${t}" belongs to a different item.`); return; }
    if (u.status !== 'available' || u.current_location_id !== selectedLocation.location_id) {
      Alert.alert('Not Available Here', `Unit "${t}" is not available at the selected source location.`);
      return;
    }
    setSelectedUnits(prev => (prev.some(x => x.id === u.id) ? prev : [...prev, u]));
    setScanTag('');
  }

  // Outbox a full equipment_units row (upsert keyed by id; synced_at omitted).
  function outboxUnit(u: EquipmentUnit) {
    appendOutbox('INSERT', 'equipment_units', {
      id: u.id, item_id: u.item_id, asset_tag: u.asset_tag,
      serial_number: u.serial_number, status: u.status,
      current_location_id: u.current_location_id, current_job_id: u.current_job_id,
      notes: u.notes, created_at: u.created_at, updated_at: u.updated_at,
      // synced_at intentionally omitted from outbox payload
    });
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
    appendLog({
      action: 'job_created', entity_type: 'job', entity_id: newJob.id,
      user_id: user.id, team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: newJob.id, note: newJob.name,
      metadata: null, device_id: null,
    });
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
    const onHand = isUnitTracked ? 0 : getStockQuantity(itemId, source);
    const baseLog = {
      user_id: user.id,
      team_id: null as string | null,
      entity_type: 'item',
      entity_id: itemId,
      unit: selectedItem.unit,
      device_id: null as string | null,
      metadata: null as string | null,
    };

    // ── Unit-tracked path: move SPECIFIC units, never touch stock_by_location ──
    if (isUnitTracked) {
      if (selectedUnits.length === 0) { Alert.alert('No Units Selected', 'Select at least one unit.'); return; }

      // Resolve + validate the destination before any writes.
      let destLabel: string;
      if (destType === 'job') {
        if (!selectedJob) { Alert.alert('Pick a Job', 'Choose or create a job first.'); return; }
        destLabel = selectedJob.name;
      } else if (destType === 'location') {
        if (!selectedDestLocation) { Alert.alert('Pick a Location', 'Choose a destination location.'); return; }
        destLabel = selectedDestLocation.name;
      } else {
        const pm = pmSelections[0];
        if (!pm || !pm.locationId) { Alert.alert('Pick a Location', 'The manager needs a destination location.'); return; }
        destLabel = pm.locationName ?? pm.pmName;
      }

      setSubmitting(true);
      for (const sel of selectedUnits) {
        let updated: EquipmentUnit;
        if (destType === 'job') {
          updated = setUnitStatus(sel.id, {
            status: 'deployed', current_job_id: selectedJob!.id, current_location_id: null,
          });
          outboxUnit(updated);
          appendLog({
            ...baseLog, action: 'checkout_to_job',
            from_location_id: source, to_location_id: null,
            job_id: selectedJob!.id, quantity: 1, note: 'unit ' + sel.asset_tag,
          });
        } else if (destType === 'location') {
          updated = setUnitStatus(sel.id, {
            status: 'available', current_location_id: selectedDestLocation!.id, current_job_id: null,
          });
          outboxUnit(updated);
          appendLog({
            ...baseLog, action: 'transfer',
            from_location_id: source, to_location_id: selectedDestLocation!.id,
            job_id: null, quantity: 1, note: 'unit ' + sel.asset_tag,
          });
        } else {
          const pmLocationId = pmSelections[0].locationId!;
          updated = setUnitStatus(sel.id, {
            status: 'available', current_location_id: pmLocationId, current_job_id: null,
          });
          outboxUnit(updated);
          appendLog({
            ...baseLog, action: 'transfer',
            from_location_id: source, to_location_id: pmLocationId,
            job_id: null, quantity: 1, note: 'unit ' + sel.asset_tag,
          });
        }
      }
      const n = selectedUnits.length;
      done(`${n} unit${n > 1 ? 's' : ''} of ${selectedItem.name} ${destType === 'job' ? 'checked out to' : 'moved to'} ${destLabel}.`);
      return;
    }

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
            <Text style={s.empty}>{isUnitTracked ? 'No available units' : 'No stock available'}</Text>
          ) : (
            <SearchablePicker
              placeholder="Search source location..."
              options={sourceOptions}
              value={sourceValue}
              onSelect={selectSource}
            />
          )}

          {isUnitTracked ? (
            <ScrollView style={{ flex: 1, marginTop: 8 }} keyboardShouldPersistTaps="handled">
              <Text style={s.label}>Select Units{selectedUnits.length > 0 ? ` (${selectedUnits.length})` : ''}</Text>
              {!selectedLocation ? (
                <Text style={s.empty}>Choose a source location first.</Text>
              ) : (
                <>
                  <BarcodeInput
                    value={scanTag}
                    onChange={setScanTag}
                    placeholder="Scan or type an asset tag..."
                  />
                  <TouchableOpacity
                    style={[s.addTagBtn, !scanTag.trim() && s.btnDisabled]}
                    disabled={!scanTag.trim()}
                    onPress={() => addUnitByTag(scanTag)}
                  >
                    <Text style={s.btnText}>+ Add Unit by Tag</Text>
                  </TouchableOpacity>

                  {availableUnits.length === 0 ? (
                    <Text style={s.empty}>No available units at this location.</Text>
                  ) : (
                    availableUnits.map(u => {
                      const checked = selectedUnits.some(x => x.id === u.id);
                      return (
                        <TouchableOpacity
                          key={u.id}
                          style={[s.row, checked && s.rowSelected]}
                          onPress={() => toggleUnit(u)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={s.rowName}>{u.asset_tag}</Text>
                            {!!u.serial_number && <Text style={s.rowSub}>S/N: {u.serial_number}</Text>}
                          </View>
                          <Text style={s.rowStock}>{checked ? '✓' : ''}</Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </>
              )}
            </ScrollView>
          ) : (
            <>
              <Text style={s.label}>Quantity</Text>
              <TextInput
                style={s.qtyInput}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </>
          )}

          <TouchableOpacity
            style={[s.btn, (isUnitTracked ? selectedUnits.length === 0 : !selectedLocation) && s.btnDisabled]}
            disabled={isUnitTracked ? selectedUnits.length === 0 : !selectedLocation}
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
              {isUnitTracked
                ? `${selectedUnits.length} unit${selectedUnits.length === 1 ? '' : 's'}`
                : formatQuantity(parseFloat(quantity) || 0, unit, cat)} · {selectedItem.name}
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
                  placeholder={canCreateJobs ? 'Search or create a job...' : 'Search jobs...'}
                  options={jobOptions}
                  value={jobValue}
                  onSelect={selectJob}
                  onCreate={canCreateJobs ? createJob : undefined}
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

                {/* Unit-tracked items always use single-PM mode; hide the toggle. */}
                {!isUnitTracked && (
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
                )}

                {pms.length === 0 && <Text style={s.empty}>No production managers found</Text>}

                {/* Force single-PM path for unit-tracked items regardless of pmMode state. */}
                {(isUnitTracked || pmMode === 'single') ? (
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
                        hideQty={isUnitTracked}
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
              onPress={() => { setCheckoutEventId(generateUUID()); setStep('confirm'); }}
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
          {isUnitTracked && (
            <>
              <Row
                label={`Units (${selectedUnits.length})`}
                value={selectedUnits.map(u => u.asset_tag).join(', ')}
              />
              {destType === 'job' && (
                <>
                  <Row label="To Job" value={selectedJob?.name ?? ''} />
                  <Row label="Action" value="Deploy (returnable)" />
                </>
              )}
              {destType === 'location' && (
                <Row label="To Location" value={selectedDestLocation?.name ?? ''} />
              )}
              {destType === 'pm' && (
                <Row
                  label="To Manager"
                  value={`${pmSelections[0]?.pmName ?? ''} → ${pmSelections[0]?.locationName ?? '?'}`}
                />
              )}
            </>
          )}
          {!isUnitTracked && destType === 'job' && (
            <>
              <Row label="Qty" value={formatQuantity(parseFloat(quantity) || 0, unit, cat)} />
              <Row label="To Job" value={selectedJob?.name ?? ''} />
              <Row
                label="Action"
                value={selectedItem && !!selectedItem.returnable ? 'Deploy (returnable)' : 'Consume'}
              />
            </>
          )}
          {!isUnitTracked && destType === 'location' && (
            <>
              <Row label="Qty" value={formatQuantity(parseFloat(quantity) || 0, unit, cat)} />
              <Row label="To Location" value={selectedDestLocation?.name ?? ''} />
            </>
          )}
          {!isUnitTracked && destType === 'pm' && pmSelections.map(p => (
            <Row
              key={p.pmId}
              label={p.pmName}
              value={`${formatQuantity(parseFloat(p.qty) || 0, unit, cat)} → ${p.locationName ?? '?'}`}
            />
          ))}
        </View>

        {/* Optional photo — media is additive and never blocks the stock move */}
        <View>
          <Text style={s.label}>Photo (optional)</Text>
          <MediaGallery entityType="checkout" entityId={checkoutEventId} canUpload={canUploadMedia} />
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
  sel, onPick, qtyEditable, qtyValue, onQtyChange, qtyDisplay, hideQty,
}: {
  sel: PmSelection;
  onPick: (loc: Location | null) => void;
  qtyEditable: boolean;
  qtyValue?: string;
  onQtyChange?: (q: string) => void;
  qtyDisplay?: string;
  /** When true, suppress all quantity display (used for unit-tracked items). */
  hideQty?: boolean;
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
      {!hideQty && (
        qtyEditable ? (
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
        )
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
  addTagBtn: {
    backgroundColor: '#2563EB', borderRadius: 10, paddingVertical: 11,
    alignItems: 'center', marginTop: 8, marginBottom: 4,
  },
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
