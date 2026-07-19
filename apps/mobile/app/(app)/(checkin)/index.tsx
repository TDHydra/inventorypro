import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, TextInput, ScrollView } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { generateUUID } from '../../../src/utils/uuid';
import { getActiveCheckoutsForUser } from '../../../src/db/queries/jobs';
import { getAllLocations, resolveLocationShelfSelection } from '../../../src/db/queries/locations';
import { rowsAs } from '../../../src/db/schema';
import { adjustStock } from '../../../src/db/queries/items';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { runInTransaction } from '../../../src/db/tx';
import { parseQuantity } from '../../../src/lib/validation';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { formatQuantity } from '../../../src/constants/units';
import { PickerOption } from '../../../src/components/SearchablePicker';
import { LocationShelfPicker } from '../../../src/components/pickers';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { getDeployedUnitsForUser, getUnitByTag, setUnitStatus } from '../../../src/db/queries/equipmentUnits';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { sortByProximity } from '../../../src/location/proximity';
import { LocationSuggestionBanner } from '../../../src/components/LocationSuggestionBanner';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { track } from '../../../src/telemetry';

interface Checkout {
  log_id: string;
  entity_id: string;
  item_name: string;
  unit: string;
  unit_category: string;
  quantity: number;
  from_location_id: string | null;
  job_name: string | null;
  job_id: string | null;
  created_at: string;
}

export default function CheckinScreen() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const router = useRouter();
  const { locked } = useMaintenanceMode();
  const refreshKey = useFocusOrDataRefresh();

  // --- Count-based checkout state ---
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [returnLocation, setReturnLocation] = useState<PickerOption | null>(null);
  const [returnShelf, setReturnShelf] = useState<PickerOption | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Deployed units state ---
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  const [showUnitModal, setShowUnitModal] = useState(false);
  const [unitReturnLocation, setUnitReturnLocation] = useState<PickerOption | null>(null);
  const [unitReturnShelf, setUnitReturnShelf] = useState<PickerOption | null>(null);
  const [scanTag, setScanTag] = useState('');
  const [scanNote, setScanNote] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null);
  const [unitSubmitting, setUnitSubmitting] = useState(false);

  // Position: request once on mount (fire-and-forget; never blocks UI).
  const { coords, request } = useCurrentPosition();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void request(); }, []);

  // Permission gate + stable UUIDs for optional movement photos
  const canUploadMedia = usePermission('upload_media');
  // Server stays authoritative; this is UX defense so users without check-in
  // rights can't fire a write that would only fail/reject on push.
  const canCheckin = usePermission('checkin_inventory');
  const [checkinEventId, setCheckinEventId] = useState<string>(() => generateUUID());
  const [unitCheckinEventId, setUnitCheckinEventId] = useState<string>(() => generateUUID());

  const checkouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user, refreshKey]);

  const deployedUnits = useMemo(() => {
    if (!user) return [];
    return getDeployedUnitsForUser(user.id);
  }, [user, refreshKey]);

  const allLocations = useMemo(() => getAllLocations(), [refreshKey]);
  // Proximity-sorted; re-runs when coords arrive after the async request.
  const sortedLocations = useMemo(
    () => sortByProximity(
      allLocations.map(l => ({ ...l, latitude: l.latitude ?? null, longitude: l.longitude ?? null })),
      coords,
    ),
    [allLocations, coords],
  );
  // First anchored location (non-null distanceM) is the nearest candidate for banners.
  const nearestLocation = useMemo(
    () => sortedLocations.find(l => l.distanceM != null) ?? null,
    [sortedLocations],
  );

  // --- Count-based handlers (unchanged) ---
  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(checkouts.map(c => c.log_id)));
  }

  // Open modal — inputs are preserved across outside-tap dismiss; reset only on submit.
  function openModal() {
    setShowModal(true);
  }

  async function handleCheckin() {
    track('action', 'checkin_confirm', { screen: 'checkin' });
    if (isWriteBlocked()) return;
    if (!user || selected.size === 0 || !returnLocation) return;
    if (!canCheckin) {
      Alert.alert('Not Allowed', 'You don’t have permission to check in inventory.');
      return;
    }

    // Resolve the (location, shelf) pair into the id stock is stored against — a
    // typed-in shelf is find-or-created here. returnLocation is non-null (guarded
    // above), so ok:true always carries a non-null id.
    const locRes = resolveLocationShelfSelection(returnLocation, returnShelf);
    if (!locRes.ok) {
      Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }
    const returnLocId = locRes.id as string;

    const toReturn = checkouts.filter(c => selected.has(c.log_id));

    // Validate all quantities before writing anything; keep the parsed values so
    // the write loop doesn't re-parse (and can't diverge from what we validated).
    const returnQtyById: Record<string, number> = {};
    for (const item of toReturn) {
      const parsed = parseQuantity(returnQtys[item.log_id] ?? '', `Return quantity for "${item.item_name}"`);
      if (!parsed.ok) {
        Alert.alert('Invalid Quantity', parsed.error);
        return;
      }
      if (parsed.value > item.quantity) {
        Alert.alert(
          'Invalid Quantity',
          `Return quantity for "${item.item_name}" cannot exceed the checked-out amount (${formatQuantity(item.quantity, item.unit, item.unit_category as any)}).`
        );
        return;
      }
      returnQtyById[item.log_id] = parsed.value;
    }

    setSubmitting(true);
    const now = new Date().toISOString();

    // Atomic batch: every item's stock adjust + outbox + log lands together, or
    // nothing does — a mid-loop failure can't leave a partial return.
    try {
      runInTransaction(() => {
        let primaryCheckinLogged = false;
        for (const item of toReturn) {
          const returnQty = returnQtyById[item.log_id];

          adjustStock(item.entity_id, returnLocId, returnQty);

          appendOutbox('ADJUST', 'stock_by_location', {
            item_id: item.entity_id,
            location_id: returnLocId,
            delta: returnQty,
            updated_at: now,
          });

          appendLog({
            user_id: user.id,
            team_id: null,
            action: 'checkin',
            entity_type: 'item',
            entity_id: item.entity_id,
            from_location_id: null,
            to_location_id: returnLocId,
            quantity: returnQty,
            unit: item.unit,
            job_id: item.job_id,
            note: null,
            metadata: null,
            device_id: null,
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
            location_accuracy: coords?.accuracy ?? null,
            ...(!primaryCheckinLogged && { id: checkinEventId }),
          });
          primaryCheckinLogged = true;
        }
      });
    } catch (err) {
      setSubmitting(false);
      Alert.alert(
        'Check-In Failed',
        `Could not return the selected items, so nothing was changed. Please try again.\n\n${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    // Side-effects only after the writes have committed.
    setSubmitting(false);
    setShowModal(false);
    // Reset modal inputs after successful submit
    setReturnLocation(null);
    setReturnShelf(null);
    setReturnQtys({});
    setCheckinEventId(generateUUID());
    Alert.alert(
      'Checked In',
      `${selected.size} item${selected.size !== 1 ? 's' : ''} returned to ${returnLocation.label}.`,
      [{ text: 'Done', onPress: () => router.replace('/(app)/(dashboard)') }]
    );
  }

  // --- Units handlers ---
  function toggleSelectUnit(id: string) {
    setSelectedUnitIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleScanAdd() {
    const tag = scanTag.trim();
    if (!tag) return;
    const unit = getUnitByTag(tag);
    if (!unit) {
      setScanNote({ text: `Tag "${tag}" not found.`, tone: 'warn' });
      return;
    }
    const inDeployed = deployedUnits.find(u => u.id === unit.id);
    if (!inDeployed) {
      setScanNote({ text: `"${tag}" is not in your deployed units.`, tone: 'warn' });
      return;
    }
    setSelectedUnitIds(prev => new Set([...prev, unit.id]));
    setScanTag('');
    setScanNote({ text: `Added: ${unit.asset_tag}`, tone: 'info' });
  }

  // Open unit modal — inputs are preserved across outside-tap dismiss; reset only on submit.
  function openUnitModal() {
    setShowUnitModal(true);
  }

  async function handleUnitCheckin() {
    track('action', 'checkin_confirm_units', { screen: 'checkin' });
    if (isWriteBlocked()) return;
    if (!user || selectedUnitIds.size === 0 || !unitReturnLocation) return;
    if (!canCheckin) {
      Alert.alert('Not Allowed', 'You don’t have permission to check in inventory.');
      return;
    }
    // Resolve the (location, shelf) pair into the id units are stored against — a
    // typed-in shelf is find-or-created here. unitReturnLocation is non-null
    // (guarded above), so ok:true always carries a non-null id.
    const locRes = resolveLocationShelfSelection(unitReturnLocation, unitReturnShelf);
    if (!locRes.ok) {
      Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }
    const unitReturnLocId = locRes.id as string;

    const toReturn = deployedUnits.filter(u => selectedUnitIds.has(u.id));
    setUnitSubmitting(true);

    // Atomic batch: each unit's status update + outbox + log lands together, or
    // nothing does — a mid-loop failure can't leave some units returned and
    // others not.
    try {
      runInTransaction(() => {
        let primaryUnitCheckinLogged = false;
        for (const unit of toReturn) {
          // Capture job_id before setUnitStatus clears it
          const jobIdForLog = unit.current_job_id;
          const u = setUnitStatus(unit.id, {
            status: 'available',
            current_location_id: unitReturnLocId,
            current_job_id: null,
          });
          // Full upsert by id; no synced_at
          appendOutbox('INSERT', 'equipment_units', {
            id: u.id,
            item_id: u.item_id,
            asset_tag: u.asset_tag,
            serial_number: u.serial_number,
            status: 'available',
            current_location_id: unitReturnLocId,
            current_job_id: null,
            notes: u.notes,
            created_at: u.created_at,
            updated_at: u.updated_at,
          });
          // appendLog self-enqueues activity_log — never separately outbox it
          appendLog({
            user_id: user.id,
            team_id: null,
            action: 'checkin',
            entity_type: 'item',
            entity_id: u.item_id,
            from_location_id: null,
            to_location_id: unitReturnLocId,
            quantity: 1,
            unit: null,
            job_id: jobIdForLog,
            note: 'unit ' + u.asset_tag,
            metadata: null,
            device_id: null,
            latitude: coords?.latitude ?? null,
            longitude: coords?.longitude ?? null,
            location_accuracy: coords?.accuracy ?? null,
            ...(!primaryUnitCheckinLogged && { id: unitCheckinEventId }),
          });
          primaryUnitCheckinLogged = true;
        }
      });
    } catch (err) {
      setUnitSubmitting(false);
      Alert.alert(
        'Check-In Failed',
        `Could not return the selected units, so nothing was changed. Please try again.\n\n${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    // Side-effects only after the writes have committed.
    setUnitSubmitting(false);
    setShowUnitModal(false);
    // Reset modal inputs after successful submit
    setUnitReturnLocation(null);
    setUnitReturnShelf(null);
    setSelectedUnitIds(new Set());
    setUnitCheckinEventId(generateUUID());
    Alert.alert(
      'Checked In',
      `${toReturn.length} unit${toReturn.length !== 1 ? 's' : ''} returned to ${unitReturnLocation.label}.`,
      [{ text: 'Done', onPress: () => router.replace('/(app)/(dashboard)') }]
    );
  }

  const hasAnything = checkouts.length > 0 || deployedUnits.length > 0;

  return (
    <>
      <Stack.Screen options={{ title: 'Check In Items', headerShown: true }} />
      <View style={s.container}>
        {/* container no longer pads (FormScreen's `content` owns the list's 16px
            inset); restore the hint's original top gap + 16px inset directly. */}
        <TooltipHint screenKey="checkin" style={{ marginTop: 16, marginHorizontal: 16 }} />
        {!hasAnything ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No Active Checkouts</Text>
            <Text style={s.emptyText}>Items you check out will appear here for return.</Text>
          </View>
        ) : (
          <FormScreen contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
            {/* ── Count-based job checkouts (unchanged) ── */}
            {checkouts.length > 0 && (
              <>
                <View style={s.topBar}>
                  <Text style={s.count}>{checkouts.length} item{checkouts.length !== 1 ? 's' : ''} out</Text>
                  <TouchableOpacity onPress={selectAll}>
                    <Text style={s.selectAll}>Select All</Text>
                  </TouchableOpacity>
                </View>

                {checkouts.map((item, idx) => {
                  const isSel = selected.has(item.log_id);
                  return (
                    <View key={item.log_id}>
                      <TouchableOpacity
                        style={[s.row, isSel && s.rowSelected]}
                        onPress={() => toggleSelect(item.log_id)}
                      >
                        <View style={[s.checkbox, isSel && s.checkboxChecked]}>
                          {isSel && <Text style={s.checkMark}>✓</Text>}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.itemName}>{item.item_name}</Text>
                          {item.job_name && <Text style={s.itemSub}>Job: {item.job_name}</Text>}
                          <Text style={s.itemSub}>{new Date(item.created_at).toLocaleDateString()}</Text>
                        </View>
                        <Text style={s.qty}>
                          {formatQuantity(item.quantity, item.unit, item.unit_category as any)}
                        </Text>
                      </TouchableOpacity>
                      {idx < checkouts.length - 1 && <View style={s.sep} />}
                    </View>
                  );
                })}

                <PrimaryButton
                  label={`Return ${selected.size > 0 ? `${selected.size} Item${selected.size !== 1 ? 's' : ''}` : 'Items'}`}
                  disabled={selected.size === 0}
                  onPress={openModal}
                  style={{ marginTop: 16 }}
                />
              </>
            )}

            {/* ── Deployed equipment (units) ── */}
            {deployedUnits.length > 0 && (
              <>
                {checkouts.length > 0 && <View style={s.sectionDivider} />}
                <View style={s.sectionHeader}>
                  <Text style={s.sectionTitle}>Deployed equipment (units)</Text>
                </View>

                <BarcodeInput
                  label="Scan or type asset tag to add"
                  value={scanTag}
                  onChange={v => { setScanTag(v); setScanNote(null); }}
                  placeholder="Asset tag..."
                  note={scanNote?.text}
                  noteTone={scanNote?.tone}
                />
                <TouchableOpacity style={s.scanAddBtn} onPress={handleScanAdd}>
                  <Text style={s.scanAddText}>Add Unit</Text>
                </TouchableOpacity>

                <View style={{ height: 10 }} />

                {deployedUnits.map((unit, idx) => {
                  const isSel = selectedUnitIds.has(unit.id);
                  return (
                    <View key={unit.id}>
                      <TouchableOpacity
                        style={[s.row, isSel && s.rowSelected]}
                        onPress={() => toggleSelectUnit(unit.id)}
                      >
                        <View style={[s.checkbox, isSel && s.checkboxChecked]}>
                          {isSel && <Text style={s.checkMark}>✓</Text>}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={s.itemName}>{unit.asset_tag}</Text>
                          <Text style={s.itemSub}>{unit.item_name}</Text>
                          {unit.job_name && <Text style={s.itemSub}>Job: {unit.job_name}</Text>}
                        </View>
                        <View style={s.unitBadge}>
                          <Text style={s.unitBadgeText}>Deployed</Text>
                        </View>
                      </TouchableOpacity>
                      {idx < deployedUnits.length - 1 && <View style={s.sep} />}
                    </View>
                  );
                })}

                <PrimaryButton
                  label={`Return ${selectedUnitIds.size > 0 ? `${selectedUnitIds.size} Unit${selectedUnitIds.size !== 1 ? 's' : ''}` : 'Units'}`}
                  disabled={selectedUnitIds.size === 0}
                  onPress={openUnitModal}
                  style={{ marginTop: 16 }}
                />
              </>
            )}

            <View style={{ height: 24 }} />
          </FormScreen>
        )}

        {/* Count-based return modal — outside-tap preserves inputs */}
        <ModalSheet visible={showModal} onClose={() => setShowModal(false)}>
          <View style={{ gap: 12 }}>
            <Text style={s.modalTitle}>Return to Location</Text>

            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              <LocationSuggestionBanner
                name={nearestLocation?.name ?? null}
                distanceM={nearestLocation?.distanceM ?? null}
                onUse={() => nearestLocation && setReturnLocation({ id: nearestLocation.id, label: nearestLocation.name })}
              />
              <LocationShelfPicker
                locationValue={returnLocation}
                shelfValue={returnShelf}
                onChangeLocation={setReturnLocation}
                onChangeShelf={setReturnShelf}
                proximitySort
              />

              {/* Per-item return quantity inputs */}
              {checkouts.filter(c => selected.has(c.log_id)).map(item => (
                <View key={item.log_id} style={s.qtyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.qtyItemName}>{item.item_name}</Text>
                    <Text style={s.qtyMax}>max {formatQuantity(item.quantity, item.unit, item.unit_category as any)}</Text>
                  </View>
                  <TextInput
                    style={s.qtyInput}
                    keyboardType="decimal-pad"
                    value={returnQtys[item.log_id] ?? String(item.quantity)}
                    onChangeText={(v) => setReturnQtys(prev => ({ ...prev, [item.log_id]: v }))}
                    selectTextOnFocus
                  />
                </View>
              ))}
            </ScrollView>

            {/* Optional photo — media is additive and never blocks the stock return */}
            <Text style={s.mediaLabel}>Photo (optional)</Text>
            <MediaGallery entityType="activity_log" entityId={checkinEventId} canUpload={canUploadMedia} />

            <PrimaryButton
              label={submitting ? 'Returning...' : 'Confirm Return'}
              loading={submitting}
              disabled={!returnLocation || locked || !canCheckin}
              onPress={handleCheckin}
            />
            {!canCheckin && (
              <Text style={s.permNote}>You don’t have permission to check in inventory.</Text>
            )}
            {locked && <MaintenanceBanner />}
            <TouchableOpacity style={s.cancel} onPress={() => setShowModal(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </ModalSheet>

        {/* Units return modal — outside-tap preserves inputs */}
        <ModalSheet visible={showUnitModal} onClose={() => setShowUnitModal(false)}>
          <View style={{ gap: 12 }}>
            <Text style={s.modalTitle}>Return Units to Location</Text>

            <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
              <LocationSuggestionBanner
                name={nearestLocation?.name ?? null}
                distanceM={nearestLocation?.distanceM ?? null}
                onUse={() => nearestLocation && setUnitReturnLocation({ id: nearestLocation.id, label: nearestLocation.name })}
              />
              <LocationShelfPicker
                locationValue={unitReturnLocation}
                shelfValue={unitReturnShelf}
                onChangeLocation={setUnitReturnLocation}
                onChangeShelf={setUnitReturnShelf}
                proximitySort
              />

              {/* Selected units summary */}
              {deployedUnits.filter(u => selectedUnitIds.has(u.id)).map(unit => (
                <View key={unit.id} style={s.qtyRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.qtyItemName}>{unit.asset_tag}</Text>
                    <Text style={s.qtyMax}>
                      {unit.item_name}{unit.job_name ? ` · ${unit.job_name}` : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>

            {/* Optional photo — media is additive and never blocks the unit return */}
            <Text style={s.mediaLabel}>Photo (optional)</Text>
            <MediaGallery entityType="activity_log" entityId={unitCheckinEventId} canUpload={canUploadMedia} />

            <PrimaryButton
              label={unitSubmitting ? 'Returning...' : 'Confirm Return'}
              loading={unitSubmitting}
              disabled={!unitReturnLocation || locked || !canCheckin}
              onPress={handleUnitCheckin}
            />
            {!canCheckin && (
              <Text style={s.permNote}>You don’t have permission to check in inventory.</Text>
            )}
            {locked && <MaintenanceBanner />}
            <TouchableOpacity style={s.cancel} onPress={() => setShowUnitModal(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </ModalSheet>
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: t.colors.textMuted },
  emptyText: { fontSize: 14, color: t.colors.textDisabled, textAlign: 'center' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  count: { fontSize: 14, color: t.colors.textSecondary },
  selectAll: { fontSize: 14, color: t.colors.primary, fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: t.colors.surface, padding: 14, borderRadius: 10,
    borderWidth: 1, borderColor: t.colors.border,
  },
  rowSelected: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  checkbox: {
    width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: t.colors.textDisabled,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.onPrimary, fontSize: 13, fontWeight: '700' },
  itemName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  itemSub: { fontSize: 12, color: t.colors.textMuted, marginTop: 2 },
  qty: { fontSize: 14, fontWeight: '600', color: t.colors.success },
  sep: { height: 6 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.brand },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  qtyItemName: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  qtyMax: { fontSize: 11, color: t.colors.textMuted, marginTop: 1 },
  qtyInput: {
    width: 80, backgroundColor: t.colors.background, borderRadius: 8, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 10, height: 40, fontSize: 15, color: t.colors.textPrimary, textAlign: 'right',
  },
  cancel: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: t.colors.textSecondary, fontSize: 15 },
  // Units section
  sectionDivider: { height: 1, backgroundColor: t.colors.border, marginVertical: 20 },
  sectionHeader: { marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: t.colors.brand },
  unitBadge: { backgroundColor: t.colors.primaryBgStrong, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  unitBadgeText: { fontSize: 12, fontWeight: '700', color: t.colors.primaryText },
  mediaLabel: { fontSize: 13, fontWeight: '600', color: t.colors.textSecondary, marginTop: 8, marginBottom: 4 },
  scanAddBtn: {
    alignSelf: 'flex-start', backgroundColor: t.colors.primaryBg, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, marginTop: 6,
    borderWidth: 1, borderColor: t.colors.border,
  },
  scanAddText: { color: t.colors.primaryText, fontWeight: '700', fontSize: 14 },
  permNote: { fontSize: 12, color: t.colors.textMuted, textAlign: 'center' },
});
