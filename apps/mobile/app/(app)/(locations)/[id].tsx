import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getLocationById, getStockAtLocation, getTopLevelLocations, upsertLocation,
  StockAtLocation, Location,
} from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { getDb } from '../../../src/db/schema';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import ActivityFeed from '../../../src/components/ActivityFeed';
import MoveStockModal from '../../../src/components/MoveStockModal';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';

// Mirror the icon/color constants from index.tsx so both screens are consistent.
const ICON_ALIASES: Record<string, string> = {
  warehouse: '🏭', store: '🏪', local_shipping: '🚚', shelves: '🗄️',
  door_back: '🚪', counter: '🧾', inventory_2: '📦',
};
const ICON_OPTIONS = ['📦', '🏭', '🏪', '🚚', '🗄️', '🚪', '🧾', '🛠️', '🧰', '🏬', '🪜', '❄️'];
const COLOR_OPTIONS = [
  '#1E3A5F', '#2E7D32', '#C62828', '#1565C0', '#6A1B9A',
  '#EF6C00', '#00695C', '#37474F', '#AD1457', '#4527A0',
];

export default function LocationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('manage_locations');
  const canUpload = usePermission('upload_media');
  const { user } = useSession();

  const [location, setLocation] = useState<Location | null>(() => getLocationById(id));
  const [stock, setStock] = useState<StockAtLocation[]>(() => getStockAtLocation(id));

  // ── Edit modal state ────────────────────────────────────────────────────────
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editParentId, setEditParentId] = useState<string | null>(null);
  const [editColor, setEditColor] = useState(COLOR_OPTIONS[0]);
  const [editIcon, setEditIcon] = useState(ICON_OPTIONS[0]);
  const [editOwnerOption, setEditOwnerOption] = useState<PickerOption | null>(null);
  const [editLatitude, setEditLatitude] = useState<number | null>(null);
  const [editLongitude, setEditLongitude] = useState<number | null>(null);

  const { coords: anchorCoords, status: anchorStatus, request: requestAnchor } = useCurrentPosition();

  // Sync GPS coords into form state when a capture completes
  useEffect(() => {
    if (anchorCoords !== null) {
      setEditLatitude(anchorCoords.latitude);
      setEditLongitude(anchorCoords.longitude);
    }
  }, [anchorCoords]);

  // ── Move stock modal state ──────────────────────────────────────────────────
  const [showMoveStock, setShowMoveStock] = useState(false);

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const userMap = useMemo<Map<string, string>>(
    () => new Map(allUsers.map(u => [u.id, u.name])),
    [allUsers],
  );
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );
  const topLevel = useMemo(() => getTopLevelLocations(), []);

  const parentName = useMemo<string | null>(() => {
    if (!location?.parent_id) return null;
    const parent = getLocationById(location.parent_id);
    return parent?.name ?? null;
  }, [location?.parent_id]);

  const ownerName = useMemo<string | null>(() => {
    if (!location?.owner_user_id) return null;
    return userMap.get(location.owner_user_id) ?? location.owner_user_id;
  }, [location?.owner_user_id, userMap]);

  if (!location) {
    return (
      <>
        <Stack.Screen options={{ title: 'Location', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Location not found.</Text></View>
      </>
    );
  }

  // ── Edit handlers ───────────────────────────────────────────────────────────

  function openEdit() {
    if (!location) return;
    // Resolve emoji for the current icon value (may be a Material-style name from seed)
    const resolvedIcon = location.icon
      ? (ICON_ALIASES[location.icon] ?? location.icon)
      : ICON_OPTIONS[0];
    setEditName(location.name);
    setEditParentId(location.parent_id);
    setEditColor(location.color ?? COLOR_OPTIONS[0]);
    setEditIcon(ICON_OPTIONS.includes(resolvedIcon) ? resolvedIcon : ICON_OPTIONS[0]);
    setEditOwnerOption(
      location.owner_user_id
        ? (userOptions.find(u => u.id === location.owner_user_id) ?? null)
        : null,
    );
    setEditLatitude(location.latitude ?? null);
    setEditLongitude(location.longitude ?? null);
    setShowEdit(true);
  }

  function doEdit() {
    if (!location) return;
    if (!editName.trim()) {
      Alert.alert('Required', 'Enter a location name.');
      return;
    }
    const now = new Date().toISOString();
    const changes = {
      name: editName.trim(),
      parent_id: editParentId,
      color: editColor,
      icon: editIcon,
      owner_user_id: editOwnerOption?.id ?? null,
      latitude: editLatitude ?? null,
      longitude: editLongitude ?? null,
    };
    upsertLocation({ ...location, ...changes, active: 1, updated_at: now, synced_at: null });
    appendOutbox('UPDATE', 'locations', { id, ...changes, active: true, updated_at: now });
    appendLog({
      action: 'location_updated',
      entity_type: 'location',
      entity_id: id,
      user_id: user?.id ?? null,
      team_id: null,
      job_id: null,
      note: changes.name,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: null,
      device_id: null,
    });
    setLocation(getLocationById(id));
    setShowEdit(false);
  }

  // ── Unarchive handler ───────────────────────────────────────────────────────

  function handleUnarchive() {
    if (!location) return;
    Alert.alert(
      'Restore Location',
      `Restore "${location.name}" to the active list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: () => {
            const now = new Date().toISOString();
            getDb().executeSync(
              `UPDATE locations SET active=1, updated_at=? WHERE id=?`,
              [now, id]
            );
            appendOutbox('UPDATE', 'locations', { id, active: true, updated_at: now });
            appendLog({
              action: 'location_restored',
              entity_type: 'location',
              entity_id: id,
              user_id: user?.id ?? null,
              team_id: null,
              job_id: null,
              note: location.name,
              from_location_id: null,
              to_location_id: null,
              quantity: null,
              unit: null,
              metadata: null,
              device_id: null,
            });
            setLocation(getLocationById(id));
          },
        },
      ]
    );
  }

  // ── Archive handler (existing, now with logging) ────────────────────────────

  function handleArchive() {
    if (!location) return;
    Alert.alert(
      'Archive Location',
      `Archive "${location.name}"? It will be hidden from active lists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            const now = new Date().toISOString();
            getDb().executeSync(
              `UPDATE locations SET active=0, updated_at=? WHERE id=?`,
              [now, id]
            );
            appendOutbox('UPDATE', 'locations', { id, active: false, updated_at: now });
            appendLog({
              action: 'location_archived',
              entity_type: 'location',
              entity_id: id,
              user_id: user?.id ?? null,
              team_id: null,
              job_id: null,
              note: location.name,
              from_location_id: null,
              to_location_id: null,
              quantity: null,
              unit: null,
              metadata: null,
              device_id: null,
            });
            router.back();
          },
        },
      ]
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: location.name, headerShown: true }} />
      <ScrollView contentContainerStyle={s.content}>

        {/* ── Header card ─────────────────────────────────────────────────── */}
        <View style={s.card}>
          {location.active === 0 && (
            <View style={s.archivedBanner}>
              <Text style={s.archivedText}>Archived</Text>
            </View>
          )}
          <View style={s.nameRow}>
            <Text style={s.name}>{location.name}</Text>
            {canManage && (
              <TouchableOpacity style={s.editBtn} onPress={openEdit}>
                <Text style={s.editBtnText}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>
          {!!parentName && (
            <View style={[s.attrRow, s.divider]}>
              <Text style={s.attrKey}>Sub-area of</Text>
              <Text style={s.attrVal}>{parentName}</Text>
            </View>
          )}
          {!!ownerName && (
            <View style={s.attrRow}>
              <Text style={s.attrKey}>Owner</Text>
              <Text style={s.attrVal}>{ownerName}</Text>
            </View>
          )}
        </View>

        {/* ── Stock here ──────────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>Stock here</Text>
        <View style={s.card}>
          {stock.length === 0 ? (
            <Text style={s.muted}>No count-based stock at this location.</Text>
          ) : (
            stock.map((row, i) => (
              <View
                key={row.item_id}
                style={[s.stockRow, i < stock.length - 1 && s.divider]}
              >
                <Text style={s.stockName} numberOfLines={1}>{row.name}</Text>
                <Text style={s.stockQty}>{row.quantity}</Text>
              </View>
            ))
          )}
          {canManage && stock.length > 0 && (
            <TouchableOpacity
              style={s.moveStockBtn}
              onPress={() => setShowMoveStock(true)}
            >
              <Text style={s.moveStockBtnText}>Move Stock</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Photos ──────────────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>Photos</Text>
        <MediaGallery entityType="location" entityId={id} canUpload={canUpload} />

        {/* ── Activity feed ───────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>Activity</Text>
        <View style={s.card}>
          <ActivityFeed entityType="location" entityId={id} />
        </View>

        {/* ── Unarchive button ─────────────────────────────────────────────── */}
        {canManage && location.active === 0 && (
          <TouchableOpacity style={[s.btn, s.btnRestore]} onPress={handleUnarchive}>
            <Text style={s.btnRestoreText}>Restore Location</Text>
          </TouchableOpacity>
        )}

        {/* ── Archive button ───────────────────────────────────────────────── */}
        {canManage && location.active === 1 && (
          <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={handleArchive}>
            <Text style={s.btnDangerText}>Archive Location</Text>
          </TouchableOpacity>
        )}

      </ScrollView>

      {/* ── Edit Modal ──────────────────────────────────────────────────────── */}
      <Modal visible={showEdit} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.modal}>
            <Text style={s.modalTitle}>Edit Location</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <TextInput
                style={s.input}
                placeholder="Location name *"
                placeholderTextColor="#94A3B8"
                value={editName}
                onChangeText={setEditName}
                autoFocus
              />

              <Text style={s.label}>Inside</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.chipRow}
              >
                <TouchableOpacity
                  style={[s.chip, editParentId === null && s.chipActive]}
                  onPress={() => setEditParentId(null)}
                >
                  <Text style={[s.chipText, editParentId === null && s.chipTextActive]}>Top level</Text>
                </TouchableOpacity>
                {topLevel.filter(t => t.id !== id).map(t => (
                  <TouchableOpacity
                    key={t.id}
                    style={[s.chip, editParentId === t.id && s.chipActive]}
                    onPress={() => setEditParentId(t.id)}
                  >
                    <Text style={[s.chipText, editParentId === t.id && s.chipTextActive]}>{t.name}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={s.label}>Belongs to (optional)</Text>
              <SearchablePicker
                placeholder="Search people…"
                options={userOptions}
                value={editOwnerOption}
                onSelect={(opt) => {
                  setEditOwnerOption(prev => (prev?.id === opt.id ? null : opt));
                }}
              />

              <Text style={s.label}>GPS Anchor</Text>
              {anchorStatus === 'denied' ? (
                <Text style={s.anchorDenied}>
                  Location permission off — you can still save without it.
                </Text>
              ) : (
                <TouchableOpacity
                  style={[s.anchorBtn, editLatitude !== null && s.anchorBtnSet]}
                  onPress={requestAnchor}
                  disabled={anchorStatus === 'loading'}
                  activeOpacity={0.7}
                >
                  <Text style={[s.anchorBtnText, editLatitude !== null && s.anchorBtnTextSet]}>
                    {anchorStatus === 'loading'
                      ? '📍 Getting location…'
                      : editLatitude !== null
                      ? '📍 Anchored ✓ · re-capture'
                      : '📍 Use my current spot'}
                  </Text>
                </TouchableOpacity>
              )}
              {editLatitude === null && anchorStatus !== 'denied' && anchorStatus !== 'loading' && (
                <Text style={s.anchorHint}>Not anchored</Text>
              )}

              <Text style={s.label}>Icon</Text>
              <View style={s.iconGrid}>
                {ICON_OPTIONS.map(ic => (
                  <TouchableOpacity
                    key={ic}
                    style={[s.iconCell, editIcon === ic && s.iconCellActive]}
                    onPress={() => setEditIcon(ic)}
                  >
                    <Text style={s.iconCellText}>{ic}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.label}>Color</Text>
              <View style={s.colorRow}>
                {COLOR_OPTIONS.map(c => (
                  <TouchableOpacity
                    key={c}
                    style={[s.colorCell, { backgroundColor: c }, editColor === c && s.colorCellActive]}
                    onPress={() => setEditColor(c)}
                  >
                    {editColor === c && <Text style={s.colorCheck}>✓</Text>}
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity style={s.saveBtn} onPress={doEdit}>
                <Text style={s.saveBtnText}>Save Changes</Text>
              </TouchableOpacity>
              <View style={s.secondaryRow}>
                <TouchableOpacity style={s.linkBtn} onPress={() => setShowEdit(false)}>
                  <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Move Stock Modal ─────────────────────────────────────────────────── */}
      <MoveStockModal
        visible={showMoveStock}
        fromLocationId={id}
        fromLocationName={location.name}
        onClose={() => setShowMoveStock(false)}
        onDone={() => {
          setShowMoveStock(false);
          setStock(getStockAtLocation(id));
        }}
      />
    </>
  );
}

const s = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: '#94A3B8' },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: '#EEF2F7',
  },

  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 22, fontWeight: '700', color: '#1E3A5F', flex: 1 },
  editBtn: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#EFF6FF', borderRadius: 8 },
  editBtnText: { color: '#2563EB', fontWeight: '700', fontSize: 13 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: 14, color: '#64748B' },
  attrVal: {
    fontSize: 14, color: '#1E293B', fontWeight: '600',
    maxWidth: '60%', textAlign: 'right',
  },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },

  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },

  stockRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 12,
  },
  stockName: { fontSize: 15, color: '#1E293B', fontWeight: '500', flex: 1, marginRight: 8 },
  stockQty: { fontSize: 15, fontWeight: '700', color: '#15803D' },

  moveStockBtn: {
    marginTop: 12, paddingVertical: 10, alignItems: 'center',
    backgroundColor: '#EFF6FF', borderRadius: 10,
  },
  moveStockBtnText: { color: '#2563EB', fontWeight: '700', fontSize: 14 },

  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  btnDanger: { backgroundColor: '#FEE2E2' },
  btnDangerText: { color: '#991B1B', fontWeight: '700', fontSize: 16 },
  btnRestore: { backgroundColor: '#DCFCE7' },
  btnRestoreText: { color: '#166534', fontWeight: '700', fontSize: 16 },

  archivedBanner: {
    backgroundColor: '#FEF3C7', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
    marginBottom: 10, alignSelf: 'flex-start',
  },
  archivedText: { color: '#92400E', fontWeight: '700', fontSize: 12 },

  // ── Edit Modal ────────────────────────────────────────────────────────────
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#F8FAFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '88%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginBottom: 14 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  iconCell: { width: 46, height: 46, borderRadius: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center' },
  iconCellActive: { borderColor: '#2563EB', backgroundColor: '#DBEAFE' },
  iconCellText: { fontSize: 22 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorCell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  colorCellActive: { borderColor: '#1E293B' },
  colorCheck: { color: '#fff', fontWeight: '800', fontSize: 16 },
  saveBtn: { backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: 8 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
  anchorBtn: { backgroundColor: '#F1F5F9', borderRadius: 10, paddingVertical: 11, paddingHorizontal: 14, borderWidth: 1, borderColor: '#CBD5E1', alignItems: 'center' },
  anchorBtnSet: { backgroundColor: '#F0FDF4', borderColor: '#86EFAC' },
  anchorBtnText: { fontSize: 14, color: '#475569', fontWeight: '600' },
  anchorBtnTextSet: { color: '#166534', fontWeight: '700' },
  anchorHint: { fontSize: 12, color: '#94A3B8', textAlign: 'center', marginTop: 2 },
  anchorDenied: { fontSize: 12, color: '#B45309', textAlign: 'center', paddingVertical: 8 },
});
