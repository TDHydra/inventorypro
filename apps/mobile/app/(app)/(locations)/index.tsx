import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Modal, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import {
  getLocationTree, getTopLevelLocations, upsertLocation,
  Location, LocationWithChildren,
} from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { MediaThumbnail } from '../../../src/components/MediaThumbnail';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';

// The app has no icon font bundled (see logs/index.tsx) — locations render an
// emoji. Map the Material-style names the seed used onto emoji so seeded rows
// look consistent with ones created in-app.
const ICON_ALIASES: Record<string, string> = {
  warehouse: '🏭', store: '🏪', local_shipping: '🚚', shelves: '🗄️',
  door_back: '🚪', counter: '🧾', inventory_2: '📦',
};

const ICON_OPTIONS = ['📦', '🏭', '🏪', '🚚', '🗄️', '🚪', '🧾', '🛠️', '🧰', '🏬', '🪜', '❄️'];

const COLOR_OPTIONS = [
  '#1E3A5F', '#2E7D32', '#C62828', '#1565C0', '#6A1B9A',
  '#EF6C00', '#00695C', '#37474F', '#AD1457', '#4527A0',
];

function renderIcon(icon: string | null): string {
  if (!icon) return '📍';
  return ICON_ALIASES[icon] ?? icon;
}

export default function LocationsScreen() {
  const canManage = usePermission('manage_locations');
  const router = useRouter();
  const { user } = useSession();

  const [tree, setTree] = useState<LocationWithChildren[]>(() => getLocationTree());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [icon, setIcon] = useState(ICON_OPTIONS[0]);
  const [ownerOption, setOwnerOption] = useState<PickerOption | null>(null);
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  const { coords: anchorCoords, status: anchorStatus, request: requestAnchor } = useCurrentPosition();

  // Sync GPS coords into form state when a capture completes
  useEffect(() => {
    if (anchorCoords !== null) {
      setLatitude(anchorCoords.latitude);
      setLongitude(anchorCoords.longitude);
    }
  }, [anchorCoords]);

  const topLevel = useMemo<Location[]>(() => getTopLevelLocations(), [tree]);

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );
  const userMap = useMemo<Map<string, string>>(
    () => new Map(allUsers.map(u => [u.id, u.name])),
    [allUsers],
  );

  // Warn (don't block) if a location with the same name already lives under the
  // same parent — real sites rarely have two "Shelf A"s in one warehouse.
  const dup = useMemo(() => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const siblings = parentId
      ? tree.find(t => t.id === parentId)?.children ?? []
      : tree;
    return siblings.find(l => l.name.trim().toLowerCase() === n) ?? null;
  }, [name, parentId, tree]);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function resetForm() {
    setName(''); setParentId(null); setColor(COLOR_OPTIONS[0]); setIcon(ICON_OPTIONS[0]); setOwnerOption(null);
    setLatitude(null); setLongitude(null);
  }

  function openCreate(presetParent: string | null = null) {
    resetForm();
    setParentId(presetParent);
    setShowCreate(true);
  }

  function doCreate() {
    const id = generateUUID();
    const now = new Date().toISOString();
    const trimmed = name.trim();
    const payload = {
      id, name: trimmed, parent_id: parentId,
      color, icon, updated_at: now, owner_user_id: ownerOption?.id ?? null,
      active: true,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
    };
    upsertLocation({ ...payload, active: 1, synced_at: null });
    appendOutbox('INSERT', 'locations', payload);
    appendLog({
      action: 'location_created',
      entity_type: 'location',
      entity_id: id,
      user_id: user?.id ?? null,
      team_id: null,
      job_id: null,
      note: trimmed,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      metadata: null,
      device_id: null,
    });
    setTree(getLocationTree());
    if (parentId) setExpanded(prev => new Set(prev).add(parentId));
    setShowCreate(false);
    resetForm();
  }

  function handleSave() {
    if (!name.trim()) {
      Alert.alert('Required', 'Enter a location name.');
      return;
    }
    if (dup) {
      Alert.alert(
        'Already exists',
        `A location named "${dup.name}" already exists ${parentId ? 'here' : 'at the top level'}. Create another anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create anyway', onPress: doCreate },
        ],
      );
      return;
    }
    doCreate();
  }

  const parentName = parentId
    ? topLevel.find(t => t.id === parentId)?.name ?? 'location'
    : null;

  return (
    <>
      <Stack.Screen options={{ title: 'Locations', headerShown: true }} />
      <View style={s.container}>
        {canManage && (
          <View style={s.topBar}>
            <Text style={s.subtitle}>{tree.length} location{tree.length === 1 ? '' : 's'}</Text>
            <TouchableOpacity style={s.addBtn} onPress={() => openCreate(null)}>
              <Text style={s.addBtnText}>+ New</Text>
            </TouchableOpacity>
          </View>
        )}

        <ScrollView contentContainerStyle={s.list}>
          {tree.length === 0 && (
            <Text style={s.empty}>
              No locations yet.{canManage ? ' Tap “+ New” to add your first warehouse, shop, or van.' : ''}
            </Text>
          )}

          {tree.map(loc => {
            const isOpen = expanded.has(loc.id);
            return (
              <View key={loc.id} style={s.group}>
                <View style={s.card}>
                  <TouchableOpacity
                    style={s.cardInner}
                    onPress={() => router.push({ pathname: '/(app)/(locations)/[id]', params: { id: loc.id } })}
                    activeOpacity={0.7}
                  >
                    <MediaThumbnail entityType="location" entityId={loc.id} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.name}>{loc.name}</Text>
                      <Text style={s.meta}>
                        {loc.children.length > 0
                          ? `${loc.children.length} sub-area${loc.children.length === 1 ? '' : 's'}`
                          : 'No sub-areas'}
                      </Text>
                      {!!loc.owner_user_id && (
                        <Text style={s.ownerMeta}>Owner: {userMap.get(loc.owner_user_id) ?? loc.owner_user_id}</Text>
                      )}
                    </View>
                  </TouchableOpacity>
                  {loc.children.length > 0 && (
                    <TouchableOpacity
                      onPress={() => toggle(loc.id)}
                      style={s.expandBtn}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Text style={s.chevron}>{isOpen ? '▾' : '▸'}</Text>
                    </TouchableOpacity>
                  )}
                </View>

                {isOpen && (
                  <View style={s.children}>
                    {loc.children.map(child => (
                      <TouchableOpacity
                        key={child.id}
                        style={s.childRow}
                        onPress={() => router.push({ pathname: '/(app)/(locations)/[id]', params: { id: child.id } })}
                      >
                        <MediaThumbnail entityType="location" entityId={child.id} size={28} />
                        <View style={{ flex: 1 }}>
                          <Text style={s.childName}>{child.name}</Text>
                          {!!child.owner_user_id && (
                            <Text style={s.ownerMeta}>Owner: {userMap.get(child.owner_user_id) ?? child.owner_user_id}</Text>
                          )}
                        </View>
                        <Text style={s.childChevron}>›</Text>
                      </TouchableOpacity>
                    ))}
                    {canManage && (
                      <TouchableOpacity style={s.addSub} onPress={() => openCreate(loc.id)}>
                        <Text style={s.addSubText}>+ Add sub-area</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>

        {/* Create modal */}
        <Modal visible={showCreate} animationType="slide" transparent>
          <KeyboardAvoidingView
            style={s.overlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={s.modal}>
              <Text style={s.modalTitle}>
                {parentName ? `New sub-area in ${parentName}` : 'New location'}
              </Text>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
                <TextInput
                  style={s.input}
                  placeholder="Location name *"
                  placeholderTextColor="#94A3B8"
                  value={name}
                  onChangeText={setName}
                  autoFocus
                />
                {!!dup && (
                  <Text style={s.dupWarn}>⚠ "{dup.name}" already exists here</Text>
                )}

                <Text style={s.label}>Inside</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
                  <TouchableOpacity
                    style={[s.chip, parentId === null && s.chipActive]}
                    onPress={() => setParentId(null)}
                  >
                    <Text style={[s.chipText, parentId === null && s.chipTextActive]}>Top level</Text>
                  </TouchableOpacity>
                  {topLevel.map(t => (
                    <TouchableOpacity
                      key={t.id}
                      style={[s.chip, parentId === t.id && s.chipActive]}
                      onPress={() => setParentId(t.id)}
                    >
                      <Text style={[s.chipText, parentId === t.id && s.chipTextActive]}>{t.name}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <Text style={s.label}>Belongs to (optional)</Text>
                <SearchablePicker
                  placeholder="Search people…"
                  options={userOptions}
                  value={ownerOption}
                  onSelect={(opt) => {
                    // Tapping "Change" re-passes current value — treat as clear
                    setOwnerOption(prev => (prev?.id === opt.id ? null : opt));
                  }}
                />

                <Text style={s.label}>GPS Anchor</Text>
                {anchorStatus === 'denied' ? (
                  <Text style={s.anchorDenied}>
                    Location permission off — you can still save without it.
                  </Text>
                ) : (
                  <TouchableOpacity
                    style={[s.anchorBtn, latitude !== null && s.anchorBtnSet]}
                    onPress={requestAnchor}
                    disabled={anchorStatus === 'loading'}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.anchorBtnText, latitude !== null && s.anchorBtnTextSet]}>
                      {anchorStatus === 'loading'
                        ? '📍 Getting location…'
                        : latitude !== null
                        ? '📍 Anchored ✓ · re-capture'
                        : '📍 Use my current spot'}
                    </Text>
                  </TouchableOpacity>
                )}
                {latitude === null && anchorStatus !== 'denied' && anchorStatus !== 'loading' && (
                  <Text style={s.anchorHint}>Not anchored</Text>
                )}

                <Text style={s.label}>Icon</Text>
                <View style={s.iconGrid}>
                  {ICON_OPTIONS.map(ic => (
                    <TouchableOpacity
                      key={ic}
                      style={[s.iconCell, icon === ic && s.iconCellActive]}
                      onPress={() => setIcon(ic)}
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
                      style={[s.colorCell, { backgroundColor: c }, color === c && s.colorCellActive]}
                      onPress={() => setColor(c)}
                    >
                      {color === c && <Text style={s.colorCheck}>✓</Text>}
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity style={s.btn} onPress={handleSave}>
                  <Text style={s.btnText}>Add Location</Text>
                </TouchableOpacity>
                <View style={s.secondaryRow}>
                  <TouchableOpacity style={s.linkBtn} onPress={resetForm}>
                    <Text style={s.linkText}>Clear</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.linkBtn} onPress={() => { setShowCreate(false); resetForm(); }}>
                    <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  subtitle: { fontSize: 13, color: '#64748B', fontWeight: '600' },
  addBtn: { backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 48 },
  empty: { textAlign: 'center', color: '#94A3B8', fontSize: 15, marginTop: 48, paddingHorizontal: 24, lineHeight: 22 },

  group: { gap: 0 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 12, padding: 12, gap: 12, borderWidth: 1, borderColor: '#E2E8F0' },
  cardInner: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  expandBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  swatch: { width: 42, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  swatchIcon: { fontSize: 20 },
  name: { fontSize: 16, fontWeight: '600', color: '#1E293B' },
  meta: { fontSize: 12, color: '#94A3B8', marginTop: 2 },
  ownerMeta: { fontSize: 11, color: '#64748B', marginTop: 2 },
  chevron: { fontSize: 18, color: '#94A3B8', paddingHorizontal: 4 },

  children: { marginLeft: 20, marginTop: 6, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: '#E2E8F0', gap: 6 },
  childRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  childDot: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  childIcon: { fontSize: 14 },
  childName: { fontSize: 14, color: '#475569', fontWeight: '500' },
  childChevron: { fontSize: 16, color: '#CBD5E1', paddingHorizontal: 2 },
  addSub: { paddingVertical: 6, paddingHorizontal: 2 },
  addSubText: { color: '#2563EB', fontSize: 13, fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modal: { backgroundColor: '#F8FAFF', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '88%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginBottom: 14 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  dupWarn: { color: '#B45309', fontSize: 13, fontWeight: '600' },
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
  btn: { backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
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
