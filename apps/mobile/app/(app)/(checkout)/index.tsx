/**
 * Checkout wizard — 4 steps:
 * 1. Find item (search or arrive with itemId param from scan)
 * 2. Pick source location + quantity
 * 3. Pick job + who for (self / team / office)
 * 4. Confirm
 */
import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { searchItems, getItemById, getStockByItem, adjustStock, getStockQuantity } from '../../../src/db/queries/items';
import { getOpenJobs, searchJobs, upsertJob } from '../../../src/db/queries/jobs';
import { useSession } from '../../../src/hooks/useSession';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { generateUUID } from '../../../src/utils/uuid';
import { formatQuantity } from '../../../src/constants/units';

type Step = 'find' | 'qty' | 'job' | 'confirm';

interface ItemRow { id: string; name: string; unit: string; unit_category: string; total_stock: number; barcode: string | null }
interface StockRow { location_id: string; location_name: string; parent_name: string | null; quantity: number }
interface JobRow { id: string; name: string; status: string }

export default function CheckoutScreen() {
  const router = useRouter();
  const { user } = useSession();
  const params = useLocalSearchParams<{ itemId?: string }>();

  const [step, setStep] = useState<Step>('find');
  const [itemSearch, setItemSearch] = useState('');
  const [selectedItem, setSelectedItem] = useState<ItemRow | null>(null);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<StockRow | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [jobSearch, setJobSearch] = useState('');
  const [selectedJob, setSelectedJob] = useState<JobRow | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<'self' | 'team' | 'office'>('self');
  const [submitting, setSubmitting] = useState(false);

  // If navigated with itemId param, skip to qty step
  useEffect(() => {
    if (params.itemId) {
      const item = getItemById(params.itemId) as ItemRow | null;
      if (item) {
        handleSelectItem(item);
      }
    }
  }, [params.itemId]);

  const itemResults = useMemo(() => {
    if (!itemSearch.trim()) return [];
    return searchItems(itemSearch, 10, 0) as ItemRow[];
  }, [itemSearch]);

  const jobResults = useMemo(() => {
    if (!jobSearch.trim()) return getOpenJobs() as JobRow[];
    return searchJobs(jobSearch) as JobRow[];
  }, [jobSearch]);

  function handleSelectItem(item: ItemRow) {
    setSelectedItem(item);
    const stockRows = getStockByItem(item.id) as StockRow[];
    setStock(stockRows.filter(s => s.quantity > 0));
    setSelectedLocation(null);
    setQuantity('1');
    setStep('qty');
  }

  async function handleConfirm() {
    if (!selectedItem || !selectedLocation || !user) return;
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      Alert.alert('Invalid Quantity', 'Enter a positive number.');
      return;
    }
    if (qty > selectedLocation.quantity) {
      Alert.alert('Not Enough Stock', `Only ${formatQuantity(selectedLocation.quantity, selectedItem.unit, selectedItem.unit_category as any)} available at this location.`);
      return;
    }

    setSubmitting(true);

    const jobId = selectedJob?.id ?? null;
    const jobName = selectedJob?.name ?? null;

    // Create job if typed a new name
    if (jobSearch.trim() && !selectedJob) {
      const newJob: JobRow = {
        id: generateUUID(),
        name: jobSearch.trim(),
        status: 'open',
      };
      upsertJob(newJob as any);
      appendOutbox('INSERT', 'jobs', { ...newJob, created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      setSelectedJob(newJob);
    }

    // Adjust stock locally, then sync the true new on-hand quantity (upsert).
    adjustStock(selectedItem.id, selectedLocation.location_id, -qty);
    appendOutbox('INSERT', 'stock_by_location', {
      item_id: selectedItem.id,
      location_id: selectedLocation.location_id,
      quantity: getStockQuantity(selectedItem.id, selectedLocation.location_id),
      updated_at: new Date().toISOString(),
    });

    // Activity log
    appendLog({
      user_id: user.id,
      team_id: checkoutFor === 'team' ? null : null, // TODO: add team_id from session
      action: 'checkout',
      entity_type: 'inventory_item',
      entity_id: selectedItem.id,
      from_location_id: selectedLocation.location_id,
      to_location_id: null,
      quantity: qty,
      unit: selectedItem.unit,
      job_id: jobId,
      note: checkoutFor === 'office' ? 'Checked out to office' : null,
      metadata: JSON.stringify({ checkout_for: checkoutFor, job_name: jobName }),
      device_id: null,
    });

    setSubmitting(false);
    Alert.alert(
      'Checked Out ✓',
      `${formatQuantity(qty, selectedItem.unit, selectedItem.unit_category as any)} of ${selectedItem.name} checked out${jobName ? ` to ${jobName}` : ''}.`,
      [{ text: 'Done', onPress: () => router.replace('/(app)/(dashboard)') }]
    );
  }

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
            stock.map(loc => (
              <TouchableOpacity
                key={loc.location_id}
                style={[s.row, selectedLocation?.location_id === loc.location_id && s.rowSelected]}
                onPress={() => setSelectedLocation(loc)}
              >
                <View style={{ flex: 1 }}>
                  {loc.parent_name && <Text style={s.rowSub}>{loc.parent_name} ›</Text>}
                  <Text style={s.rowName}>{loc.location_name}</Text>
                </View>
                <Text style={s.rowStock}>{formatQuantity(loc.quantity, selectedItem.unit, selectedItem.unit_category as any)}</Text>
              </TouchableOpacity>
            ))
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
            style={[s.btn, (!selectedLocation) && s.btnDisabled]}
            disabled={!selectedLocation}
            onPress={() => setStep('job')}
          >
            <Text style={s.btnText}>Next: Choose Job →</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </>
    );
  }

  if (step === 'job') {
    return (
      <>
        <Stack.Screen options={{ title: 'Job & Purpose', headerShown: true }} />
        <View style={s.container}>
          <Text style={s.label}>Who is this for?</Text>
          <View style={s.forRow}>
            {(['self', 'team', 'office'] as const).map(opt => (
              <TouchableOpacity
                key={opt}
                style={[s.forBtn, checkoutFor === opt && s.forBtnActive]}
                onPress={() => setCheckoutFor(opt)}
              >
                <Text style={[s.forBtnText, checkoutFor === opt && s.forBtnTextActive]}>
                  {opt === 'self' ? 'Myself' : opt === 'team' ? 'My Team' : 'Office'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.label}>Job (optional)</Text>
          <TextInput
            style={s.input}
            placeholder="Search or type a new job name..."
            value={jobSearch}
            onChangeText={setJobSearch}
            autoCapitalize="words"
          />
          <FlatList
            data={jobResults}
            keyExtractor={j => j.id}
            style={{ maxHeight: 200 }}
            renderItem={({ item: job }) => (
              <TouchableOpacity
                style={[s.row, selectedJob?.id === job.id && s.rowSelected]}
                onPress={() => { setSelectedJob(job); setJobSearch(job.name); }}
              >
                <Text style={s.rowName}>{job.name}</Text>
              </TouchableOpacity>
            )}
            ItemSeparatorComponent={() => <View style={s.sep} />}
          />

          <TouchableOpacity style={s.btn} onPress={() => setStep('confirm')}>
            <Text style={s.btnText}>Review Checkout →</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  // Confirm step
  return (
    <>
      <Stack.Screen options={{ title: 'Confirm Checkout', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.confirmContent}>
        <Text style={s.confirmTitle}>Review & Confirm</Text>

        <View style={s.confirmCard}>
          <Row label="Item" value={selectedItem?.name ?? ''} />
          <Row label="Qty" value={formatQuantity(parseFloat(quantity) || 0, selectedItem?.unit ?? '', selectedItem?.unit_category as any ?? '')} />
          <Row label="From" value={[selectedLocation?.parent_name, selectedLocation?.location_name].filter(Boolean).join(' › ')} />
          <Row label="For" value={{ self: 'Myself', team: 'My Team', office: 'Office' }[checkoutFor]} />
          {(selectedJob || jobSearch.trim()) && (
            <Row label="Job" value={selectedJob?.name ?? jobSearch.trim() + ' (new)'} />
          )}
        </View>

        <TouchableOpacity style={s.btn} disabled={submitting} onPress={handleConfirm}>
          <Text style={s.btnText}>{submitting ? 'Checking out...' : 'Confirm Checkout ✓'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.btnSecondary} onPress={() => setStep('job')}>
          <Text style={s.btnSecondaryText}>← Go Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
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
  rowName: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
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
  confirmTitle: { fontSize: 22, fontWeight: '700', color: '#1E3A5F' },
  confirmCard: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1,
    borderColor: '#E2E8F0', padding: 16, gap: 12,
  },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between' },
  confirmLabel: { fontSize: 14, color: '#64748B' },
  confirmValue: { fontSize: 14, fontWeight: '600', color: '#1E293B', flex: 1, textAlign: 'right' },
});
