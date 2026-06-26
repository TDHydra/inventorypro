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

interface Checkout {
  log_id: string;
  entity_id: string;
  item_name: string;
  unit: string;
  unit_category: string;
  quantity: number;
  from_location_id: string | null;
  job_name: string | null;
  created_at: string;
}

interface Location { id: string; name: string; parent_id: string | null; parent_name?: string }

export default function CheckinScreen() {
  const { user } = useSession();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [locationSearch, setLocationSearch] = useState('');
  const [returnLocation, setReturnLocation] = useState<Location | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const checkouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user]);

  const locations = useMemo(() => getAllLocations() as Location[], []);
  const filteredLocations = useMemo(() => {
    const q = locationSearch.toLowerCase();
    return locations.filter(l => l.name.toLowerCase().includes(q));
  }, [locations, locationSearch]);

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

  async function handleCheckin() {
    if (!user || selected.size === 0 || !returnLocation) return;
    setSubmitting(true);

    const toReturn = checkouts.filter(c => selected.has(c.log_id));

    for (const item of toReturn) {
      adjustStock(item.entity_id, returnLocation.id, item.quantity);
      appendOutbox('INSERT', 'stock_by_location', {
        item_id: item.entity_id,
        location_id: returnLocation.id,
        quantity: getStockQuantity(item.entity_id, returnLocation.id),
        updated_at: new Date().toISOString(),
      });

      appendLog({
        user_id: user.id,
        team_id: null,
        action: 'checkin',
        entity_type: 'inventory_item',
        entity_id: item.entity_id,
        from_location_id: null,
        to_location_id: returnLocation.id,
        quantity: item.quantity,
        unit: item.unit,
        job_id: null,
        note: null,
        metadata: JSON.stringify({ original_log_id: item.log_id }),
        device_id: null,
      });
    }

    setSubmitting(false);
    setShowModal(false);
    Alert.alert(
      'Checked In ✓',
      `${selected.size} item${selected.size !== 1 ? 's' : ''} returned to ${returnLocation.name}.`,
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
              onPress={() => setShowModal(true)}
            >
              <Text style={s.btnText}>Return {selected.size > 0 ? `${selected.size} Item${selected.size !== 1 ? 's' : ''}` : 'Items'}</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Location picker modal */}
        <Modal visible={showModal} animationType="slide" transparent>
          <View style={s.modalOverlay}>
            <View style={s.modal}>
              <Text style={s.modalTitle}>Return to Location</Text>
              <TextInput
                style={s.searchInput}
                placeholder="Search location..."
                value={locationSearch}
                onChangeText={setLocationSearch}
              />
              <ScrollView style={{ maxHeight: 300 }}>
                {filteredLocations.map(loc => (
                  <TouchableOpacity
                    key={loc.id}
                    style={[s.locRow, returnLocation?.id === loc.id && s.locRowSelected]}
                    onPress={() => setReturnLocation(loc)}
                  >
                    <Text style={s.locName}>{loc.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <TouchableOpacity
                style={[s.btn, (!returnLocation || submitting) && s.btnDisabled]}
                disabled={!returnLocation || submitting}
                onPress={handleCheckin}
              >
                <Text style={s.btnText}>{submitting ? 'Returning...' : 'Confirm Return ✓'}</Text>
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
  searchInput: {
    backgroundColor: '#F8FAFF', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 42, fontSize: 14, color: '#1E293B',
  },
  locRow: { padding: 12, borderRadius: 8 },
  locRowSelected: { backgroundColor: '#EFF6FF' },
  locName: { fontSize: 15, color: '#1E293B' },
  cancel: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { color: '#64748B', fontSize: 15 },
});
