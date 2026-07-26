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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { validateReturnDestination, buildReturnLogRows } from '../../../src/scan/returnBatch';
import { sanitizeScan } from '../../../src/scan/sanitize';
import { isHidSupported, connectHidScanner } from '../../../src/scan/hidScanner.web';
import { applyConsumableAction } from '../../../src/scan/stockActions';
import { runInTransaction } from '../../../src/db/tx';
import { searchEverything, type GlobalSearchResults } from '../../../src/db/queries/search';
import {
  searchItems, getStockByItem, getStockQuantity, type InventoryItem,
} from '../../../src/db/queries/items';
import { getLocationById, getStockAtLocation } from '../../../src/db/queries/locations';
import { getUnitInventoryLock } from '../../../src/db/queries/access';
import { getEquipmentModels, type EquipmentModel } from '../../../src/db/queries/equipment';
import { setUnitStatus, type EquipmentUnit } from '../../../src/db/queries/equipmentUnits';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { generateUUID } from '../../../src/utils/uuid';
import { formatQuantity } from '../../../src/constants/units';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { partitionBySourceStock } from '../../../src/hooks/locScope';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

type Mode = 'browse' | 'scanning' | 'inout' | 'destination' | 'receipt';

export default function HubScreen() {
  const s = useThemedStyles(makeStyles);
  // Edge-to-edge: the batch-scan panel is position:absolute/bottom:40 (fixed)
  // over the full-screen camera, so the transparent gesture/3-button nav bar
  // can overlay its "Done scanning" button without this inset (same class of
  // bug as BulkActionBar / ScanReceipt, #163).
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useSession();
  const { coords, request } = useCurrentPosition();

  // ── Permission gate (Task 13 Step 3) ────────────────────────────────────────
  const canCheckout = usePermission('checkout_inventory');
  const canCheckin = usePermission('checkin_inventory');
  const canAdd = usePermission('add_inventory');
  const canScanAct = canCheckout || canCheckin || canAdd;

  const params = useLocalSearchParams<{ scan?: string; q?: string; loc?: string; dir?: string }>();
  // #83: Fast Check-In enters with dir=in so the scan flow runs a check-IN
  // (item sheet opens on 'in'); everything else defaults to check-out.
  const flowDir: 'in' | 'out' = params.dir === 'in' ? 'in' : 'out';
  const [mode, setMode] = useState<Mode>('browse');
  const [query, setQuery] = useState('');
  const [flapOpen, setFlapOpen] = useState(false);

  // Global data-version (not per-table): searchEverything + the catalog span
  // items/stock/equipment/locations/jobs/users, so re-read on any change.
  const dataVersion = useDataVersion();

  // Deep-link entry points from the dashboard search bar: ?scan=1 jumps straight
  // to the camera; ?q=<text> opens with the flap revealed and the query prefilled.
  useEffect(() => {
    if (params.scan === '1' && canScanAct) setMode('scanning');
    if (params.q) { setQuery(params.q); setFlapOpen(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.scan, params.q]);

  // ?loc=<locationId> (#127 fast checkout) — a SCOPING CONTEXT, not a phase:
  // browse/search item results narrow to stock at that location, and a plain
  // check-OUT commits directly from it (self checkout — no DestinationPicker).
  // Cleared with the ✕ on the banner; everything else behaves as before.
  const [locId, setLocId] = useState<string | null>(null);
  useEffect(() => {
    if (params.loc) setLocId(params.loc);
  }, [params.loc]);
  // Unknown/stale ids (or a location deleted mid-session) resolve to null and
  // scope nothing — the banner simply doesn't render.
  const locContext = useMemo(() => (locId ? getLocationById(locId) : null), [locId, dataVersion]);
  // #140: quantity map, not a visibility filter — the catalog/search below must
  // stay browsable even when the source has no stock rows yet (fresh vehicle).
  const locQtyByItem = useMemo(
    () => (locContext ? new Map(getStockAtLocation(locContext.id).map(r => [r.item_id, r.quantity] as const)) : null),
    [locContext?.id, dataVersion],
  );
  // #162: a loc-context that is another team's vehicle/locker locks the fast
  // in/out flows (visibility stays — #157). The reason renders on the banner
  // and gates onInOutChosen; applyConsumableAction re-checks before writing.
  const locLock = useMemo(
    () => getUnitInventoryLock(user, locContext?.id),
    [user?.id, locContext?.id, dataVersion],
  );

  // Consumable in/out working state.
  const [pendingItem, setPendingItem] = useState<InventoryItem | null>(null);
  const [pendingAction, setPendingAction] = useState<{ item: InventoryItem; dir: 'in' | 'out'; qty: number } | null>(null);
  const [needSource, setNeedSource] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceSel, setSourceSel] = useState<PickerOption | null>(null);

  // Equipment batch-checkout accumulator (Task 15). Carries the item name so the
  // batch bar can list each queued unit ("AM-004 · Drill"), not just a count.
  const [equipBatch, setEquipBatch] = useState<(EquipmentUnit & { item_name: string })[]>([]);

  // #151: hub equipment RETURNS accumulator (Fast Check-In, dir=in). Same shape
  // as equipBatch — the two never populate in the same session since flowDir is
  // fixed per screen open (out → equipBatch, in → returnBatch).
  const [returnBatch, setReturnBatch] = useState<(EquipmentUnit & { item_name: string })[]>([]);

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
    [dataVersion],
  );
  const catalogEquipment = useMemo(() => getEquipmentModels(), [dataVersion]);

  // Live grouped search results.
  const rawResults: GlobalSearchResults = useMemo(
    () => searchEverything(query),
    [query, dataVersion],
  );
  const hasQuery = query.trim().length > 0;

  // Scope item results (browse catalog + search) to the loc context by
  // PARTITION, never by dropping (#140): at-source items lead, the rest of the
  // catalog stays reachable. The commit-time "Not enough here" guard is what
  // keeps writes honest.
  const scopedCatalog = useMemo(
    () => (locQtyByItem ? partitionBySourceStock(catalogItems, locQtyByItem) : null),
    [catalogItems, locQtyByItem],
  );
  const results: GlobalSearchResults = useMemo(() => {
    if (!locQtyByItem) return rawResults;
    const { atSource, elsewhere } = partitionBySourceStock(rawResults.items, locQtyByItem);
    return { ...rawResults, items: [...atSource, ...elsewhere] };
  }, [rawResults, locQtyByItem]);

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
    // Bound/clean the scanned value before it reaches queries or nav params.
    const code = sanitizeScan(raw);
    if (!code) return; // ignore empty / over-length / control-char junk
    // In-flight guard: a HID/repeat scan must not clobber a consumable action
    // that's already mid-flow (item picked or in/out chosen) — that would lose
    // the first item or double-apply on retry.
    if (pendingItem || pendingAction) {
      Alert.alert('Finish the current item first.');
      return;
    }
    const c = classifyScan(code);
    if (c.kind === 'rejected') { Alert.alert('Unverified code', 'This code couldn’t be verified — it may be damaged, forged, or not an InventoryPro label.'); return; }
    if (c.kind === 'unknown') { promptAddNewItem(c.code); return; }       // Task 14 (c.code is the sanitized scan)
    if (c.kind === 'consumable') { setPendingItem(c.item); setMode('inout'); return; }
    // #151: in the Fast Check-In flow, an equipment-unit scan is a hub RETURN,
    // not a checkout — enqueue it into returnBatch instead. (Scanning a bare
    // equipment MODEL tag in this flow still can't be resolved to one physical
    // unit; bidirectional smart-scan disambiguation is a separate backlog item.)
    if (flowDir === 'in') {
      enqueueReturn(c);
      return;
    }
    // equipment-unit / equipment-model → batch checkout (Task 15)
    enqueueEquipment(c);
  }

  // Closing the scanner: if we've accumulated equipment, go resolve a destination;
  // otherwise return to browse.
  function onScannerClose() {
    if (equipBatch.length > 0 || returnBatch.length > 0) { setMode('destination'); return; }
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
        setEquipBatch(prev => (prev.some(u => u.id === c.unit.id) ? prev : [...prev, { ...c.unit, item_name: c.item.name }]));
      } else if (c.unit.status === 'deployed') {
        // #151: a deployed unit belongs in a RETURN, not a checkout — point the
        // user at Fast Check-In instead of a dead-end "not available".
        Alert.alert('Not available', `${c.unit.asset_tag} is checked out, not available to check out again. Use Fast Check-In to return it.`);
      } else {
        Alert.alert('Not available', `${c.unit.asset_tag} is ${c.unit.status}, not available to check out.`);
      }
    } else if (c.kind === 'equipment-model') {
      Alert.alert('Scan a unit tag', 'Scan the asset tag on the specific unit to check it out.');
    }
    // Immediately reopen the camera for the next scan.
    setMode('scanning');
  }

  // Drop a wrongly-scanned unit from the batch without leaving the scanner.
  function removeFromBatch(id: string) {
    setEquipBatch(prev => prev.filter(u => u.id !== id));
  }

  // #151 — hub returns (Fast Check-In, dir=in): accumulate scanned deployed
  // units into returnBatch, reopen the camera. Policy: ANY deployed unit
  // qualifies, not just the scanner's own — this is a supervisor tool; the
  // dedicated Check In screen keeps its own-units restriction.
  function enqueueReturn(c: ScanClass) {
    if (c.kind === 'equipment-unit') {
      if (c.unit.status === 'deployed') {
        setReturnBatch(prev => (prev.some(u => u.id === c.unit.id) ? prev : [...prev, { ...c.unit, item_name: c.item.name }]));
      } else {
        Alert.alert('Not checked out', `${c.unit.asset_tag} isn’t checked out.`);
      }
    } else if (c.kind === 'equipment-model') {
      Alert.alert('Scan a unit tag', 'Scan the asset tag on the specific unit to return it.');
    }
    setMode('scanning');
  }

  // Drop a wrongly-scanned unit from the return batch without leaving the scanner.
  function removeFromReturnBatch(id: string) {
    setReturnBatch(prev => prev.filter(u => u.id !== id));
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
    // #162: the loc-context is another team's unit — no stock in or out of it.
    if (locContext && locLock.locked) {
      Alert.alert('Team inventory', locLock.reason ?? 'This unit belongs to another team.');
      return;
    }
    const item = pendingItem;
    // Loc context check-out = "take it with me" from that location: source is
    // pre-filled and the write commits immediately — no DestinationPicker phase.
    if (dir === 'out' && locContext) {
      if (getStockQuantity(item.id, locContext.id) < qty) {
        Alert.alert(
          'Not enough here',
          `Only ${formatQuantity(getStockQuantity(item.id, locContext.id), item.unit, item.unit_category as any)} at ${locContext.name}.`,
        );
        return; // keep the sheet open so they can adjust the quantity
      }
      commitSelfCheckout(item, qty, locContext.id, locContext.name);
      return;
    }
    // #83 symmetric fast check-IN: "put it back in my locker/vehicle" — the
    // loc-context IS the destination, so deposit immediately with no picker
    // (mirror of the fast check-out path above).
    if (dir === 'in' && locContext) {
      commitSelfCheckin(item, qty, locContext.id, locContext.name);
      return;
    }
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

  // #139: scoped check-out to a chosen destination (another location / vehicle
  // / locker / job) instead of "take it with me". Source is the loc-context, so
  // no source-picker step — jump straight to the DestinationPicker.
  function onInOutToDestination(dir: 'in' | 'out', qty: number) {
    if (!pendingItem || dir !== 'out' || !locContext) return;
    if (!canCheckout) {
      Alert.alert('Not authorized', 'You don’t have permission to check out inventory.');
      return;
    }
    // #162: taking stock OUT of another team's unit is locked too.
    if (locLock.locked) {
      Alert.alert('Team inventory', locLock.reason ?? 'This unit belongs to another team.');
      return;
    }
    if (getStockQuantity(pendingItem.id, locContext.id) < qty) {
      Alert.alert(
        'Not enough here',
        `Only ${formatQuantity(getStockQuantity(pendingItem.id, locContext.id), pendingItem.unit, pendingItem.unit_category as any)} at ${locContext.name}.`,
      );
      return;
    }
    setPendingAction({ item: pendingItem, dir: 'out', qty });
    setNeedSource(false);
    setSourceId(locContext.id);
    setSourceSel(null);
    setMode('destination');
  }

  // #127 fast checkout: deduct from the loc-context source with no destination
  // (the tech takes it into the field). Same failure discipline as the
  // destination path — an error must not show a receipt or "scan another?".
  function commitSelfCheckout(item: InventoryItem, qty: number, srcId: string, srcName: string) {
    try {
      applyConsumableAction({
        itemId: item.id, unit: item.unit, direction: 'out', qty,
        sourceLocationId: srcId,
        destLocationId: null,
        jobId: null,
        userId: user?.id ?? null,
        note: `Taken from ${srcName}`,
        coords: coords
          ? { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }
          : undefined,
      });
    } catch (err) {
      Alert.alert(
        'Could not save',
        ((err as Error)?.message || 'The stock change failed.') +
          '\n\nNothing was changed. Please try again.',
      );
      resetConsumable();
      setMode('browse');
      return;
    }
    pushReceiptEntry({
      id: generateUUID(), itemName: item.name, direction: 'out',
      qtyLabel: formatQuantity(qty, item.unit, item.unit_category as any),
      destLabel: `Taken · from ${srcName}`, at: new Date().toISOString(),
    });
    resetConsumable();
    setMode('browse'); // leave the inout overlay before the "scan another?" prompt
    askAnythingElse();
  }

  // #83 fast check-in: deposit into the loc-context destination with no source
  // (returning field stock to a locker/vehicle). Same failure discipline as
  // commitSelfCheckout — an error must not show a receipt or "scan another?".
  function commitSelfCheckin(item: InventoryItem, qty: number, destId: string, destName: string) {
    try {
      applyConsumableAction({
        itemId: item.id, unit: item.unit, direction: 'in', qty,
        sourceLocationId: null,
        destLocationId: destId,
        jobId: null,
        userId: user?.id ?? null,
        note: `Returned to ${destName}`,
        coords: coords
          ? { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }
          : undefined,
      });
    } catch (err) {
      Alert.alert(
        'Could not save',
        ((err as Error)?.message || 'The stock change failed.') +
          '\n\nNothing was changed. Please try again.',
      );
      resetConsumable();
      setMode('browse');
      return;
    }
    pushReceiptEntry({
      id: generateUUID(), itemName: item.name, direction: 'in',
      qtyLabel: formatQuantity(qty, item.unit, item.unit_category as any),
      destLabel: `Returned · to ${destName}`, at: new Date().toISOString(),
    });
    resetConsumable();
    setMode('browse');
    askAnythingElse();
  }

  // Source-location options for the destination step (locations holding stock).
  // #162: sources inside another team's vehicle/locker stay VISIBLE (per #157)
  // but carry the lock reason and can't be selected without the cross-team perm.
  const sourceOptions: PickerOption[] = useMemo(() => {
    if (!pendingAction) return [];
    const item = pendingAction.item;
    return getStockByItem(item.id)
      .filter(s => s.quantity > 0)
      .map(s => {
        const lock = getUnitInventoryLock(user, s.location_id);
        return {
          id: s.location_id,
          label: s.location_name,
          sublabel: lock.locked
            ? lock.reason ?? '🔒 Team inventory'
            : formatQuantity(s.quantity, item.unit, item.unit_category as any),
        };
      });
  }, [pendingAction, dataVersion, user?.id]);

  function selectSource(opt: PickerOption) {
    // #162: block picking another team's unit as the source.
    const lock = getUnitInventoryLock(user, opt.id);
    if (lock.locked) {
      Alert.alert('Team inventory', lock.reason ?? 'This unit belongs to another team.');
      return;
    }
    setSourceSel(opt);
    setSourceId(opt.id);
  }

  // ── destination resolve (consumable + equipment batch) ──────────────────────
  function onDestResolved(dest: ResolvedDestination | null) {
    if (!dest) return; // incomplete selection

    // #151 — hub returns path: location-only destinations (v1 policy).
    if (returnBatch.length > 0) { commitReturnBatch(dest); return; }

    // Equipment batch path (Task 15 Step 2).
    if (equipBatch.length > 0) { commitEquipmentBatch(dest); return; }

    // Consumable path.
    if (!pendingAction) return;
    const { item, dir, qty } = pendingAction;
    if (dir === 'out' && !sourceId) {
      Alert.alert('Pick a source', 'Choose where this is coming from.');
      return;
    }

    // Guard the write: if the stock change throws we must NOT show a receipt
    // or "scan another?" (that would be false success and a retry would
    // double-apply). applyConsumableAction already runs its own transaction.
    try {
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
    } catch (err) {
      Alert.alert(
        'Could not save',
        ((err as Error)?.message || 'The stock change failed.') +
          '\n\nNothing was changed. Please try again.',
      );
      resetConsumable();
      setMode('browse');
      return;
    }
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
    // #162: a queued unit sitting INSIDE another team's vehicle/locker can't be
    // moved out of it, and the destination can't be a foreign unit either.
    const blockedUnit = equipBatch.find(u => getUnitInventoryLock(user, u.current_location_id).locked);
    const destLock = getUnitInventoryLock(user, dest.toLocationId);
    if (blockedUnit || destLock.locked) {
      const reason = blockedUnit
        ? getUnitInventoryLock(user, blockedUnit.current_location_id).reason
        : destLock.reason;
      Alert.alert(
        'Team inventory',
        (blockedUnit ? `${blockedUnit.asset_tag}: ` : '') + (reason ?? 'This unit belongs to another team.'),
      );
      return;
    }
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
    // Commit the whole batch atomically: a mid-loop failure must not leave some
    // units moved + outboxed and others not. runInTransaction rolls back every
    // write if any unit fails; we then tell the user which unit broke and send
    // them back to the scanner with the batch cleared (no false success).
    let failedUnit: string | null = null;
    try {
      runInTransaction(() => {
        for (const u of equipBatch) {
          failedUnit = u.asset_tag;
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
      });
    } catch (err) {
      Alert.alert(
        'Checkout failed',
        `Couldn't check out ${failedUnit ? `unit ${failedUnit}` : 'the batch'}. ` +
          'Nothing was changed — no units were moved.' +
          ((err as Error)?.message ? `\n\n${(err as Error).message}` : ''),
      );
      setEquipBatch([]);
      setMode('scanning');
      return;
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

  // #151 — commit the hub RETURN batch. Mirrors commitEquipmentBatch above and
  // the checkin unit loop ((checkin)/index.tsx:271-364): v1 policy restricts
  // the destination to a Location (validateReturnDestination); #162 guards the
  // destination itself (a queued unit has no current_location_id while
  // deployed, so there's nothing to lock-check on the source side, unlike the
  // checkout batch above). One runInTransaction, stable event UUID on the
  // first log row (buildReturnLogRows), aggregate ScanReceipt + askAnythingElse.
  function commitReturnBatch(dest: ResolvedDestination) {
    const check = validateReturnDestination(dest);
    if (!check.ok) {
      Alert.alert('Pick a location', check.reason);
      return;
    }
    const toLocationId = dest.toLocationId as string;
    const destLock = getUnitInventoryLock(user, toLocationId);
    if (destLock.locked) {
      Alert.alert('Team inventory', destLock.reason ?? 'This unit belongs to another team.');
      return;
    }
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
    const eventId = generateUUID();
    const logRows = buildReturnLogRows(returnBatch, toLocationId, eventId);
    let failedUnit: string | null = null;
    try {
      runInTransaction(() => {
        returnBatch.forEach((u, i) => {
          failedUnit = u.asset_tag;
          const updated = setUnitStatus(u.id, {
            status: 'available', current_location_id: toLocationId, current_job_id: null,
          });
          outboxUnit(updated);
          appendLog({ ...baseLog, ...logRows[i] });
        });
      });
    } catch (err) {
      Alert.alert(
        'Check-in failed',
        `Couldn't return ${failedUnit ? `unit ${failedUnit}` : 'the batch'}. ` +
          'Nothing was changed — no units were moved.' +
          ((err as Error)?.message ? `\n\n${(err as Error).message}` : ''),
      );
      setReturnBatch([]);
      setMode('scanning');
      return;
    }
    const n = returnBatch.length;
    const label = `${n} unit${n > 1 ? 's' : ''}`;
    pushReceiptEntry({
      id: generateUUID(), itemName: label, direction: 'in',
      qtyLabel: label, destLabel: receiptLabelFor('in', dest), at: new Date().toISOString(),
    });
    setReturnBatch([]);
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
          <View style={[s.batchBar, { bottom: 40 + insets.bottom }]} pointerEvents="box-none">
            <View style={s.batchPanel} pointerEvents="auto">
              <Text style={s.batchHeading}>
                {equipBatch.length} unit{equipBatch.length > 1 ? 's' : ''} queued
              </Text>
              <ScrollView style={s.batchList} keyboardShouldPersistTaps="handled">
                {equipBatch.map(u => (
                  <View key={u.id} style={s.batchRow}>
                    <Text style={s.batchRowText} numberOfLines={1}>
                      {u.asset_tag} · {u.item_name}
                    </Text>
                    <TouchableOpacity
                      onPress={() => removeFromBatch(u.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={s.batchRemove}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
              <TouchableOpacity style={s.batchDone} onPress={() => setMode('destination')}>
                <Text style={s.batchDoneText}>Done scanning →</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {/* #151: hub returns batch — same panel, "↩" row prefix + return copy. */}
        {returnBatch.length > 0 && (
          <View style={[s.batchBar, { bottom: 40 + insets.bottom }]} pointerEvents="box-none">
            <View style={s.batchPanel} pointerEvents="auto">
              <Text style={s.batchHeading}>
                {returnBatch.length} unit{returnBatch.length > 1 ? 's' : ''} to return
              </Text>
              <ScrollView style={s.batchList} keyboardShouldPersistTaps="handled">
                {returnBatch.map(u => (
                  <View key={u.id} style={s.batchRow}>
                    <Text style={s.batchRowText} numberOfLines={1}>
                      ↩ {u.asset_tag} · {u.item_name}
                    </Text>
                    <TouchableOpacity
                      onPress={() => removeFromReturnBatch(u.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Text style={s.batchRemove}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
              <TouchableOpacity style={s.batchDone} onPress={() => setMode('destination')}>
                <Text style={s.batchDoneText}>Done scanning →</Text>
              </TouchableOpacity>
            </View>
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
        {locContext && (
          <View style={s.locBanner}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={s.locBannerText} numberOfLines={1}>From: {locContext.name}</Text>
              {locLock.locked && (
                <Text style={s.locBannerLock} numberOfLines={1}>{locLock.reason}</Text>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setLocId(null)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Clear source location"
            >
              <Text style={s.locBannerClear}>✕</Text>
            </TouchableOpacity>
          </View>
        )}
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
              sourceQty={locQtyByItem}
              sourceName={locContext?.name}
              onItem={goItem}
              onEquipment={goEquipment}
              onLocation={goLocation}
              onJob={goJob}
              onUser={goUser}
            />
          ) : (
            <View style={{ gap: 10 }}>
              {scopedCatalog ? (
                <>
                  {scopedCatalog.atSource.length > 0 && (
                    <Text style={s.sectionHeader}>At {locContext?.name}</Text>
                  )}
                  {scopedCatalog.atSource.length === 0 && catalogItems.length > 0 && (
                    <Text style={s.empty}>Nothing in stock at {locContext?.name} — full catalog below.</Text>
                  )}
                  {scopedCatalog.atSource.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      onCheckout={(itemId) => router.push({ pathname: '/(app)/(checkout)', params: { itemId, loc: locId! } })}
                    />
                  ))}
                  {scopedCatalog.elsewhere.length > 0 && (
                    <Text style={s.sectionHeader}>Elsewhere in catalog</Text>
                  )}
                  {scopedCatalog.elsewhere.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      onCheckout={(itemId) => router.push({ pathname: '/(app)/(checkout)', params: { itemId, loc: locId! } })}
                    />
                  ))}
                </>
              ) : (
                catalogItems.map(item => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    onCheckout={(itemId) => router.push({ pathname: '/(app)/(checkout)', params: { itemId } })}
                  />
                ))
              )}
              {!locContext && catalogEquipment.length > 0 && (
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
              {locContext
                ? catalogItems.length === 0 && (
                    <Text style={s.empty}>No catalog items yet.</Text>
                  )
                : catalogItems.length === 0 && catalogEquipment.length === 0 && (
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
        defaultDirection={flowDir}
        // #139: from a scoped source, offer a destination (another location /
        // vehicle / locker / job) alongside the one-tap "take it with me".
        secondaryLabel={locContext ? 'Send somewhere…' : undefined}
        onSecondary={locContext ? onInOutToDestination : undefined}
      />

      {/* Destination resolve (consumable + equipment batch + return batch) */}
      <ModalSheet
        visible={mode === 'destination'}
        onClose={() => { resetConsumable(); setEquipBatch([]); setReturnBatch([]); setMode('browse'); }}
        scroll
      >
        {returnBatch.length > 0 ? (
          <Text style={s.sheetTitle}>
            {returnBatch.length} unit{returnBatch.length > 1 ? 's' : ''} to return → where to?
          </Text>
        ) : equipBatch.length > 0 ? (
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
  results, sourceQty, sourceName, onItem, onEquipment, onLocation, onJob, onUser,
}: {
  results: GlobalSearchResults;
  /** #140 loc context: per-item quantity at the source location (null = no context). */
  sourceQty?: ReadonlyMap<string, number> | null;
  sourceName?: string;
  onItem: (id: string) => void;
  onEquipment: (id: string) => void;
  onLocation: (id: string) => void;
  onJob: (id: string) => void;
  onUser: (id: string) => void;
}) {
  const s = useThemedStyles(makeStyles);
  const total =
    results.items.length + results.equipment.length + results.locations.length +
    results.jobs.length + results.users.length;
  if (total === 0) return <Text style={s.empty}>No matches.</Text>;

  return (
    <View style={{ gap: 6 }}>
      {results.items.length > 0 && <Text style={s.sectionHeader}>Items</Text>}
      {results.items.map(i => {
        let sub = i.barcode
          ? `${i.barcode} · ${formatQuantity(i.total_stock, i.unit, i.unit_category as any)}`
          : formatQuantity(i.total_stock, i.unit, i.unit_category as any);
        if (sourceQty && sourceName) {
          const here = sourceQty.get(i.id) ?? 0;
          sub += here > 0
            ? ` · ${formatQuantity(here, i.unit, i.unit_category as any)} at ${sourceName}`
            : ` · none at ${sourceName}`;
        }
        return <ResultRow key={i.id} label={i.name} sub={sub} onPress={() => onItem(i.id)} />;
      })}

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
  const s = useThemedStyles(makeStyles);
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 80 },
  sectionHeader: {
    fontSize: 13, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.colors.surface, padding: 14,
    borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
  },
  rowName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: 12, color: t.colors.textMuted, marginTop: 2 },
  rowChevron: { fontSize: 22, color: t.colors.textMuted, marginLeft: 8 },
  empty: { textAlign: 'center', color: t.colors.textMuted, marginTop: 24 },
  label: { fontSize: 13, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 6 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  headerScan: { paddingHorizontal: 8, paddingVertical: 4 },
  headerScanIcon: { fontSize: 22 },
  locBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 12, marginTop: 10, paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: 8, backgroundColor: t.colors.primaryBg,
  },
  locBannerText: { fontSize: 14, fontWeight: '700', color: t.colors.primaryText },
  locBannerLock: { fontSize: 12, fontWeight: '600', color: t.colors.primaryText, opacity: 0.85, marginTop: 2 },
  locBannerClear: { fontSize: 15, fontWeight: '700', color: t.colors.primaryText },
  hidButton: {
    marginHorizontal: 12, marginTop: 10, paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 8, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface,
    alignItems: 'center',
  },
  hidButtonText: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  batchBar: {
    position: 'absolute', bottom: 40, left: 0, right: 0,
    paddingHorizontal: 20,
  },
  batchPanel: {
    backgroundColor: 'rgba(0,0,0,0.72)', borderRadius: 12, padding: 12,
  },
  batchHeading: {
    color: '#fff', fontSize: 13, fontWeight: '700', opacity: 0.85, marginBottom: 8,
  },
  batchList: { maxHeight: 168 },
  batchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 6,
  },
  batchRowText: { flex: 1, color: '#fff', fontSize: 15, fontWeight: '600', marginRight: 10 },
  batchRemove: { color: '#fff', fontSize: 16, fontWeight: '700', opacity: 0.7, paddingHorizontal: 4 },
  batchDone: {
    marginTop: 10, backgroundColor: t.colors.primary, paddingVertical: 12, borderRadius: 8,
    alignItems: 'center',
  },
  batchDoneText: { color: t.colors.onPrimary, fontSize: 15, fontWeight: '700' },
  gate: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: t.colors.background },
  gateTitle: { fontSize: 20, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 8 },
  gateSub: { fontSize: 15, color: t.colors.textSecondary, textAlign: 'center', marginBottom: 24 },
});
