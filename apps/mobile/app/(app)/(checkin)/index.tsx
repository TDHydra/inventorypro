import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity,
  StyleSheet, Alert, Modal, TextInput, ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { generateUUID } from '../../../src/utils/uuid';
import { getActiveCheckoutsForUser } from '../../../src/db/queries/jobs';
import { getAllLocations } from '../../../src/db/queries/locations';
import { rowsAs } from '../../../src/db/schema';
import { adjustStock, getStockQuantity } from '../../../src/db/queries/items';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { formatQuantity } from '../../../src/constants/units';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { getDeployedUnitsForUser, getUnitByTag, setUnitStatus } from '../../../src/db/queries/equipmentUnits';

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
  const { user } = useSession();
  const router = useRouter();

  // --- Count-based checkout state ---
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [returnLocation, setReturnLocation] = useState<PickerOption | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // --- Deployed units state ---
  const [unitRefreshKey, setUnitRefreshKey] = useState(0);
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());
  const [showUnitModal, setShowUnitModal] = useState(false);
  const [unitReturnLocation, setUnitReturnLocation] = useState<PickerOption | null>(null);
  const [scanTag, setScanTag] = useState('');
  const [scanNote, setScanNote] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null);
  const [unitSubmitting, setUnitSubmitting] = useState(false);

  // Permission gate + stable UUIDs for optional movement photos
  const canUploadMedia = usePermission('upload_media');
  const [checkinEventId, setCheckinEventId] = useState<string>(() => generateUUID());
  const [unitCheckinEventId, setUnitCheckinEventId] = useState<string>(() => generateUUID());

  const checkouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user]);

  const deployedUnits = useMemo(() => {
    if (!user) return [];
    return getDeployedUnitsForUser(user.id);
  }, [user, unitRefreshKey]);

  const locationOptions: PickerOption[] = useMemo(() => {
    const all = getAllLocations();
    const nameMap = new Map(all.map(l => [l.id, l.name]));
    return all.map(l => ({
      id: l.id,
      label: l.name,
      sublabel: l.parent_id ? nameMap.get(l.parent_id) : undefined,
    }));
  }, []);

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

  function openModal() {
    setCheckinEventId(generateUUID());
    const initial: Record<string, string> = {};
    for (const c of checkouts) {
      if (selected.has(c.log_id)) {
        initial[c.log_id] = String(c.quantity);
      }
    }
    setReturnQtys(initial);
    setReturnLocation(null);
    setShowModal(true);
  }

  async function handleCheckin() {
    if (!user || selected.size === 0 || !returnLocation) return;

    const toReturn = checkouts.filter(c => selected.has(c.log_id));

    // Validate all quantities before writing anything
    for (const item of toReturn) {
      const entered = parseFloat(returnQtys[item.log_id] ?? '');
      if (isNaN(entered) || entered <= 0) {
        Alert.alert('Invalid Quantity', `Return quantity for "${item.item_name}" must be greater than 0.`);
        return;
      }
      if (entered > item.quantity) {
        Alert.alert(
          'Invalid Quantity',
          `Return quantity for "${item.item_name}" cannot exceed the checked-out amount (${formatQuantity(item.quantity, item.unit, item.unit_category as any)}).`
        );
        return;
      }
    }

    setSubmitting(true);
    const now = new Date().toISOString();

    for (const item of toReturn) {
      const returnQty = parseFloat(returnQtys[item.log_id] ?? '');

      adjustStock(item.entity_id, returnLocation.id, returnQty);

      appendOutbox('INSERT', 'stock_by_location', {
        item_id: item.entity_id,
        location_id: returnLocation.id,
        quantity: getStockQuantity(item.entity_id, returnLocation.id),
        updated_at: now,
      });

      appendLog({
        user_id: user.id,
        team_id: null,
        action: 'checkin',
        entity_type: 'item',
        entity_id: item.entity_id,
        from_location_id: null,
        to_location_id: returnLocation.id,
        quantity: returnQty,
        unit: item.unit,
        job_id: item.job_id,
        note: null,
        metadata: null,
        device_id: null,
      });
    }

    setSubmitting(false);
    setShowModal(false);
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

  function openUnitModal() {
    setUnitCheckinEventId(generateUUID());
    setUnitReturnLocation(null);
    setShowUnitModal(true);
  }

  async function handleUnitCheckin() {
    if (!user || selectedUnitIds.size === 0 || !unitReturnLocation) return;
    const toReturn = deployedUnits.filter(u => selectedUnitIds.has(u.id));
    setUnitSubmitting(true);

    for (const unit of toReturn) {
      // Capture job_id before setUnitStatus clears it
      const jobIdForLog = unit.current_job_id;
      const u = setUnitStatus(unit.id, {
        status: 'available',
        current_location_id: unitReturnLocation.id,
        current_job_id: null,
      });
      // Full upsert by id; no synced_at
      appendOutbox('INSERT', 'equipment_units', {
        id: u.id,
        item_id: u.item_id,
        asset_tag: u.asset_tag,
        serial_number: u.serial_number,
        status: 'available',
        current_location_id: unitReturnLocation.id,
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
        to_location_id: unitReturnLocation.id,
        quantity: 1,
        unit: null,
        job_id: jobIdForLog,
        note: 'unit ' + u.asset_tag,
        metadata: null,
        device_id: null,
      });
    }

    setUnitSubmitting(false);
    setShowUnitModal(false);
    setSelectedUnitIds(new Set());
    setUnitRefreshKey(k => k + 1);
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
        {!hasAnything ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No Active Checkouts</Text>
            <Text style={s.emptyText}>Items you check out will appear here for return.</Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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

                <TouchableOpacity
                  style={[s.btn, selected.size === 0 && s.btnDisabled]}
                  disabled={selected.size === 0}
                  onPress={openModal}
                >
                  <Text style={s.btnText}>Return {selected.size > 0 ? `${selected.size} Item${selected.size !== 1 ? 's' : ''}` : 'Items'}</Text>
                </TouchableOpacity>
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

                <TouchableOpacity
                  style={[s.btn, selectedUnitIds.size === 0 && s.btnDisabled]}
                  disabled={selectedUnitIds.size === 0}
                  onPress={openUnitModal}
                >
                  <Text style={s.btnText}>
                    Return {selectedUnitIds.size > 0 ? `${selectedUnitIds.size} Unit${selectedUnitIds.size !== 1 ? 's' : ''}` : 'Units'}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <View style={{ height: 24 }} />
          </ScrollView>
        )}

        {/* Count-based return modal (unchanged) */}
        <Modal visible={showModal} animationType="slide" transparent>
          <View style={s.modalOverlay}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>Return to Location</Text>

              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                <SearchablePicker
                  placeholder="Search destination location..."
                  options={locationOptions}
                  value={returnLocation}
                  onSelect={(opt) => {
                    if (returnLocation && returnLocation.id === opt.id) {
                      setReturnLocation(null);
                    } else {
                      setReturnLocation(opt);
                    }
                  }}
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
              <MediaGallery entityType="checkin" entityId={checkinEventId} canUpload={canUploadMedia} />

              <TouchableOpacity
                style={[s.btn, (!returnLocation || submitting) && s.btnDisabled]}
                disabled={!returnLocation || submitting}
                onPress={handleCheckin}
              >
                <Text style={s.btnText}>{submitting ? 'Returning...' : 'Confirm Return'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.cancel} onPress={() => setShowModal(false)}>
                <Text style={s.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* Units return modal */}
        <Modal visible={showUnitModal} animationType="slide" transparent>
          <View style={s.modalOverlay}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>Return Units to Location</Text>

              <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
                <SearchablePicker
                  placeholder="Search destination location..."
                  options={locationOptions}
                  value={unitReturnLocation}
                  onSelect={(opt) => {
                    if (unitReturnLocation && unitReturnLocation.id === opt.id) {
                      setUnitReturnLocation(null);
                    } else {
                      setUnitReturnLocation(opt);
                    }
                  }}
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
              <MediaGallery entityType="checkin" entityId={unitCheckinEventId} canUpload={canUploadMedia} />

              <TouchableOpacity
                style={[s.btn, (!unitReturnLocation || unitSubmitting) && s.btnDisabled]}
                disabled={!unitReturnLocation || unitSubmitting}
                onPress={handleUnitCheckin}
              >
                <Text style={s.btnText}>{unitSubmitting ? 'Returning...' : 'Confirm Return'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.cancel} onPress={() => setShowUnitModal(false)}>
                <Text style={s.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF', padding: 16 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#94A3B8' },
  emptyText: { fontSize: 14, color: '#CBD5E1', textAlign: 'center' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  count: { fontSize: 14, color: '#64748B' },
  selectAll: { fontSize: 14, color: '#2563EB', fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', padding: 14, borderRadius: 10,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  rowSelected: { borderColor: '#2563EB', backgroundColor: '#EFF6FF' },
  checkbox: {
    width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: '#CBD5E1',
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#2563EB', borderColor: '#2563EB' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  itemName: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  itemSub: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  qty: { fontSize: 14, fontWeight: '600', color: '#16A34A' },
  sep: { height: 6 },
  btn: { backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  btnDisabled: { backgroundColor: '#93C5FD' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1E3A5F' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  qtyItemName: { fontSize: 14, fontWeight: '600', color: '#1E293B' },
  qtyMax: { fontSize: 11, color: '#94A3B8', marginTop: 1 },
  qtyInput: {
    width: 80, backgroundColor: '#F8FAFF', borderRadius: 8, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 10, height: 40, fontSize: 15, color: '#1E293B', textAlign: 'right',
  },
  cancel: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: '#64748B', fontSize: 15 },
  // Units section
  sectionDivider: { height: 1, backgroundColor: '#E2E8F0', marginVertical: 20 },
  sectionHeader: { marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#1E3A5F' },
  unitBadge: { backgroundColor: '#DBEAFE', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  unitBadgeText: { fontSize: 12, fontWeight: '700', color: '#1D4ED8' },
  mediaLabel: { fontSize: 13, fontWeight: '600', color: '#64748B', marginTop: 8, marginBottom: 4 },
  scanAddBtn: {
    alignSelf: 'flex-start', backgroundColor: '#EFF6FF', borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, marginTop: 6,
    borderWidth: 1, borderColor: '#BFDBFE',
  },
  scanAddText: { color: '#1D4ED8', fontWeight: '700', fontSize: 14 },
});
