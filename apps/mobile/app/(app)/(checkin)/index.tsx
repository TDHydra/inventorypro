import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  StyleSheet, Alert, Modal, TextInput, ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { getActiveCheckoutsForUser } from '../../../src/db/queries/jobs';
import { getAllLocations } from '../../../src/db/queries/locations';
import { rowsAs } from '../../../src/db/schema';
import { adjustStock, getStockQuantity } from '../../../src/db/queries/items';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { formatQuantity } from '../../../src/constants/units';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [returnLocation, setReturnLocation] = useState<PickerOption | null>(null);
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const checkouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user]);

  const locationOptions: PickerOption[] = useMemo(() => {
    const all = getAllLocations();
    const nameMap = new Map(all.map(l => [l.id, l.name]));
    return all.map(l => ({
      id: l.id,
      label: l.name,
      sublabel: l.parent_id ? nameMap.get(l.parent_id) : undefined,
    }));
  }, []);

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

  return (
    <>
      <Stack.Screen options={{ title: 'Check In Items', headerShown: true }} />
      <View style={s.container}>
        {checkouts.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyTitle}>No Active Checkouts</Text>
            <Text style={s.emptyText}>Items you check out will appear here for return.</Text>
          </View>
        ) : (
          <>
            <View style={s.topBar}>
              <Text style={s.count}>{checkouts.length} item{checkouts.length !== 1 ? 's' : ''} out</Text>
              <TouchableOpacity onPress={selectAll}>
                <Text style={s.selectAll}>Select All</Text>
              </TouchableOpacity>
            </View>

            <FlatList
              data={checkouts}
              keyExtractor={c => c.log_id}
              renderItem={({ item }) => {
                const isSel = selected.has(item.log_id);
                return (
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
                );
              }}
              ItemSeparatorComponent={() => <View style={s.sep} />}
            />

            <TouchableOpacity
              style={[s.btn, selected.size === 0 && s.btnDisabled]}
              disabled={selected.size === 0}
              onPress={openModal}
            >
              <Text style={s.btnText}>Return {selected.size > 0 ? `${selected.size} Item${selected.size !== 1 ? 's' : ''}` : 'Items'}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Return modal */}
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
                    // If same option tapped again (via "Change"), clear to allow re-picking
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
});
