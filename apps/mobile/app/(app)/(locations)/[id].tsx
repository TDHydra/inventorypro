import { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Switch,
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
import { GpsAnchorField } from '../../../src/components/GpsAnchorField';
import { ICON_ALIASES, ICON_OPTIONS, COLOR_OPTIONS } from '../../../src/constants/locationStyles';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';

export default function LocationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('manage_locations');
  const canUpload = usePermission('upload_media');
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

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
  const [editRequireOwner, setEditRequireOwner] = useState(false);

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

  // Owner becomes mandatory when the selected parent has subareas_require_owner=1.
  // Reactive to editParentId so re-parenting under a flagged parent updates the gate.
  const ownerRequired = useMemo<boolean>(() => {
    if (!editParentId) return false;
    return getLocationById(editParentId)?.subareas_require_owner === 1;
  }, [editParentId]);
  const ownerMissing = ownerRequired && !editOwnerOption;

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
    setEditRequireOwner(location.subareas_require_owner === 1);
    setShowEdit(true);
  }

  function doEdit() {
    if (!location) return;
    if (isWriteBlocked()) return;
    if (!editName.trim()) {
      Alert.alert('Required', 'Enter a location name.');
      return;
    }
    if (ownerMissing) {
      Alert.alert('Owner required', 'This sub-area requires an owner. Pick a person before saving.');
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
    // subareas_require_owner: real boolean in the outbox, INTEGER locally (mirrors `active`).
    upsertLocation({
      ...location, ...changes,
      subareas_require_owner: editRequireOwner ? 1 : 0,
      active: 1, updated_at: now, synced_at: null,
    });
    appendOutbox('UPDATE', 'locations', {
      id, ...changes,
      subareas_require_owner: editRequireOwner,
      active: true, updated_at: now,
    });
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

      {/* ── Edit Modal — onClose ONLY hides the sheet; edit inputs are preserved on
          outside-tap dismiss. Form is re-populated on openEdit(); no explicit Clear exists. ── */}
      <ModalSheet visible={showEdit} onClose={() => setShowEdit(false)}>
          <Text style={s.modalTitle}>Edit Location</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <AppInput
              placeholder="Location name *"
              value={editName}
              onChangeText={setEditName}
              autoFocus
            />

            <FieldLabel>Inside</FieldLabel>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.chipRow}
            >
              <FilterChip label="Top level" active={editParentId === null} onPress={() => setEditParentId(null)} />
              {topLevel.filter(t => t.id !== id).map(t => (
                <FilterChip
                  key={t.id}
                  label={t.name}
                  active={editParentId === t.id}
                  onPress={() => setEditParentId(t.id)}
                />
              ))}
            </ScrollView>

            <FieldLabel>{ownerRequired ? 'Belongs to (required)' : 'Belongs to (optional)'}</FieldLabel>
            <SearchablePicker
              placeholder="Search people…"
              options={userOptions}
              value={editOwnerOption}
              onSelect={(opt) => {
                setEditOwnerOption(prev => (prev?.id === opt.id ? null : opt));
              }}
            />
            {ownerMissing && (
              <Text style={s.ownerError}>
                This sub-area's parent requires an owner — pick a person to save.
              </Text>
            )}

            <FieldLabel>GPS Anchor</FieldLabel>
            <GpsAnchorField
              value={editLatitude !== null && editLongitude !== null ? { latitude: editLatitude, longitude: editLongitude } : null}
              onChange={(c) => { setEditLatitude(c?.latitude ?? null); setEditLongitude(c?.longitude ?? null); }}
              disabled={locked}
            />

            <FieldLabel>Icon</FieldLabel>
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

            <FieldLabel>Color</FieldLabel>
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

            <View style={s.switchRow}>
              <Text style={s.switchLabel}>Subareas require an owner</Text>
              <Switch value={editRequireOwner} onValueChange={setEditRequireOwner} disabled={locked} />
            </View>

            <PrimaryButton
              label="Save Changes"
              onPress={doEdit}
              disabled={locked || ownerMissing}
              style={{ marginTop: spacing.sm }}
            />
            {locked && <MaintenanceBanner />}
            <View style={s.secondaryRow}>
              <TouchableOpacity style={s.linkBtn} onPress={() => setShowEdit(false)}>
                <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
      </ModalSheet>

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
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: fontSizes.body, color: colors.textMuted },

  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.lg,
    borderWidth: 1, borderColor: colors.borderDetail,
  },

  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: fontSizes.xl, fontWeight: '700', color: colors.brand, flex: 1 },
  editBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, backgroundColor: colors.primaryBg, borderRadius: radii.sm },
  editBtnText: { color: colors.primary, fontWeight: '700', fontSize: fontSizes.body2 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: fontSizes.body, color: colors.textSecondary },
  attrVal: {
    fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '600',
    maxWidth: '60%', textAlign: 'right',
  },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },

  sectionLabel: {
    fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },

  stockRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: spacing.md,
  },
  stockName: { fontSize: fontSizes.md, color: colors.textPrimary, fontWeight: '500', flex: 1, marginRight: spacing.sm },
  stockQty: { fontSize: fontSizes.md, fontWeight: '700', color: colors.success },

  moveStockBtn: {
    marginTop: spacing.md, paddingVertical: 10, alignItems: 'center',
    backgroundColor: colors.primaryBg, borderRadius: radii.md,
  },
  moveStockBtnText: { color: colors.primary, fontWeight: '700', fontSize: fontSizes.body },

  btn: { borderRadius: radii.lg, paddingVertical: 13, alignItems: 'center', marginTop: spacing.sm },
  btnDanger: { backgroundColor: colors.dangerBg },
  btnDangerText: { color: colors.danger, fontWeight: '700', fontSize: fontSizes.base },
  btnRestore: { backgroundColor: '#DCFCE7' },
  btnRestoreText: { color: colors.success, fontWeight: '700', fontSize: fontSizes.base },

  archivedBanner: {
    backgroundColor: '#FEF3C7', borderRadius: radii.sm,
    paddingHorizontal: 10, paddingVertical: 4,
    marginBottom: 10, alignSelf: 'flex-start',
  },
  archivedText: { color: '#92400E', fontWeight: '700', fontSize: fontSizes.caption },

  // ── Edit Modal (overlay + sheet handled by ModalSheet primitive) ──────────
  modalTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.base },
  chipRow: { gap: spacing.sm, paddingRight: spacing.sm },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  iconCell: { width: 46, height: 46, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  iconCellActive: { borderColor: colors.primary, backgroundColor: colors.primaryBgStrong },
  iconCellText: { fontSize: 22 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorCell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  colorCellActive: { borderColor: colors.textPrimary },
  colorCheck: { color: '#fff', fontWeight: '800', fontSize: fontSizes.base },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: spacing.sm },
  linkBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  linkText: { color: colors.primary, fontSize: fontSizes.md, fontWeight: '600' },
  cancelText: { color: colors.textMuted },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: colors.textPrimary, flex: 1, marginRight: 12 },
  ownerError: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
});
