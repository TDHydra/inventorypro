import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getLocationById, getStockAtLocation, upsertLocation,
  getBrowsableLocations, getLocationPath, getDescendantIds,
  getShelvesForParent, setShelfColor,
  StockAtLocation, Location,
} from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { LabelPrintSheet } from '../../../src/components/LabelPrintSheet';
import { getDb } from '../../../src/db/schema';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { UserPicker } from '../../../src/components/pickers';
import ActivityFeed from '../../../src/components/ActivityFeed';
import MoveStockModal from '../../../src/components/MoveStockModal';
import { GpsAnchorField } from '../../../src/components/GpsAnchorField';
import { getLocationTypes, getLocationTypesWithFallback, getLocationSubtypes, getLocationSubtypesWithFallback, getLocationTypeRules } from '../../../src/db/queries/taxonomy';
import { ICON_ALIASES, ICON_OPTIONS, COLOR_OPTIONS, renderIcon } from '../../../src/constants/locationStyles';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { KeyValueRow } from '../../../src/components/ui/KeyValueRow';
import { confirmSheet } from '../../../src/components/ui/ConfirmSheet';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';

export default function LocationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('manage_locations');
  const canUpload = usePermission('upload_media');
  const canAddStock = usePermission('edit_inventory');
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const refreshKey = useFocusOrDataRefresh();
  const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

  const [location, setLocation] = useState<Location | null>(() => getLocationById(id));
  const [stock, setStock] = useState<StockAtLocation[]>(() => getStockAtLocation(id));

  // ── Edit modal state ────────────────────────────────────────────────────────
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editParentId, setEditParentId] = useState<string | null>(null);
  const [editColor, setEditColor] = useState(COLOR_OPTIONS[0]);
  const [editIcon, setEditIcon] = useState(ICON_OPTIONS[0]);
  const [editLocType, setEditLocType] = useState<string | null>(null);
  const [editOwnerOption, setEditOwnerOption] = useState<PickerOption | null>(null);
  const [editLatitude, setEditLatitude] = useState<number | null>(null);
  const [editLongitude, setEditLongitude] = useState<number | null>(null);
  const [editRequireOwner, setEditRequireOwner] = useState(false);
  const [editHasShelves, setEditHasShelves] = useState(false);

  // ── Move stock modal state ──────────────────────────────────────────────────
  const [showMoveStock, setShowMoveStock] = useState(false);

  // ── Print-QR sheet state ─────────────────────────────────────────────────────
  const [showPrintLabel, setShowPrintLabel] = useState(false);

  // Location-type taxonomy for the edit picker. A SUB-AREA (has a parent) offers
  // the sub-area types (Closet, Section, Storage, Shelf, Area, Bin, Rack) — note
  // 'Shelf' IS a valid sub-area type, so it's NOT filtered out here. A TOP-LEVEL
  // location offers the location_type list (Shop, Vehicle, …) with 'Shelf'
  // filtered out defensively (it's a hardcoded sub-level type, see
  // findOrCreateShelf, never a real top-level type to re-assign to).
  const isSubArea = editParentId != null;
  const locationTypes = useMemo(
    () =>
      isSubArea
        ? getLocationSubtypesWithFallback()
        : getLocationTypesWithFallback().filter(t => t.label !== 'Shelf'),
    [refreshKey, isSubArea],
  );
  // label→icon map (incl. archived) for rendering the header badge, built from
  // BOTH top-level and sub-area types so a sub-area's badge icon resolves too.
  const typeIconByLabel = useMemo(
    () => new Map([
      ...getLocationTypes({ includeInactive: true }).map(t => [t.label, t.icon] as const),
      ...getLocationSubtypes({ includeInactive: true }).map(t => [t.label, t.icon] as const),
    ]),
    [refreshKey],
  );

  const allUsers = useMemo(() => getAllActiveUsers(), [refreshKey]);
  const userMap = useMemo<Map<string, string>>(
    () => new Map(allUsers.map(u => [u.id, u.name])),
    [allUsers],
  );
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );
  // Valid parent choices = all active, non-shelf locations EXCEPT this one and
  // its descendants (re-parenting under a descendant would create a cycle),
  // labelled by full path. Shelves are excluded — they're a sub-level, not a
  // container, so nothing can be nested "inside" one. Locations are bounded →
  // client-side filtering is fine.
  const parentOptions = useMemo<PickerOption[]>(() => {
    const blocked = getDescendantIds(id);
    return getBrowsableLocations()
      .filter(l => !blocked.has(l.id))
      .map(l => ({ id: l.id, label: getLocationPath(l.id) }));
  }, [id, refreshKey]);

  // This location's shelves (only relevant when has_shelves is/was on). Reloaded
  // after any color change or focus refresh.
  const [shelves, setShelves] = useState<Location[]>(() => getShelvesForParent(id));
  useEffect(() => { setShelves(getShelvesForParent(id)); }, [id, refreshKey]);
  // Which shelf's color-picker row is expanded, if any.
  const [coloringShelfId, setColoringShelfId] = useState<string | null>(null);

  function handleSetShelfColor(shelfId: string, color: string | null) {
    if (isWriteBlocked()) return;
    try {
      setShelfColor(shelfId, color, user?.id ?? null);
    } catch (e) {
      Alert.alert('Save failed', `Couldn't update the shelf color. Please try again.\n\n${String((e as Error)?.message ?? e)}`);
      return;
    }
    setShelves(getShelvesForParent(id));
    setColoringShelfId(null);
  }

  // Per-location-type form rules (migration 022): gps (show the GPS anchor) and
  // requiresOwner (force an owner). Defaults gps=true/requiresOwner=false. A
  // SUB-AREA lives inside a parent, so it has no separate GPS anchor of its own —
  // force gps=false (owner requirement still comes from the parent below).
  const rules = isSubArea ? { gps: false, requiresOwner: false } : getLocationTypeRules(editLocType);
  // Owner becomes mandatory when the selected parent has subareas_require_owner=1
  // OR the chosen type requires it (e.g. Vehicle). Reactive to editParentId and
  // editLocType so re-parenting/retyping updates the gate.
  const ownerRequired = useMemo<boolean>(() => {
    const parentReq = editParentId ? getLocationById(editParentId)?.subareas_require_owner === 1 : false;
    // Sub-area types carry no requiresOwner rule of their own; the parent's flag
    // is the only owner gate for a sub-area.
    const typeReq = isSubArea ? false : getLocationTypeRules(editLocType).requiresOwner;
    return parentReq || typeReq;
  }, [editParentId, editLocType, isSubArea]);
  const ownerMissing = ownerRequired && !editOwnerOption;

  const parentName = useMemo<string | null>(() => {
    if (!location?.parent_id) return null;
    // Full ancestor path of the parent (e.g. "Site A › Floor 2").
    return getLocationPath(location.parent_id) || null;
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
    setEditLocType(location.type ?? null);
    setEditOwnerOption(
      location.owner_user_id
        ? (userOptions.find(u => u.id === location.owner_user_id) ?? null)
        : null,
    );
    setEditLatitude(location.latitude ?? null);
    setEditLongitude(location.longitude ?? null);
    setEditRequireOwner(location.subareas_require_owner === 1);
    setEditHasShelves(location.has_shelves === 1);
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
      type: editLocType ?? null,
      color: editColor,
      icon: editIcon,
      owner_user_id: editOwnerOption?.id ?? null,
      // A no-GPS type (e.g. switching to Vehicle) clears any coords so a location
      // never keeps hidden, uneditable lat/lng.
      latitude: rules.gps ? (editLatitude ?? null) : null,
      longitude: rules.gps ? (editLongitude ?? null) : null,
    };
    // subareas_require_owner: real boolean in the outbox, INTEGER locally (mirrors `active`).
    // Atomic: local row upsert + outbox + log either all land or none do.
    try {
      runInTransaction(() => {
        upsertLocation({
          ...location, ...changes,
          subareas_require_owner: editRequireOwner ? 1 : 0,
          has_shelves: editHasShelves ? 1 : 0,
          active: 1, updated_at: now, synced_at: null,
        });
        appendOutbox('UPDATE', 'locations', {
          id, ...changes,
          subareas_require_owner: editRequireOwner,
          has_shelves: editHasShelves,
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
      });
    } catch (e) {
      Alert.alert('Save failed', `Couldn't save changes to this location. Nothing was changed — please try again.\n\n${String((e as Error)?.message ?? e)}`);
      return;
    }
    // Only reflect success in the UI after the writes committed.
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
            try {
              runInTransaction(() => {
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
              });
            } catch (e) {
              Alert.alert('Restore failed', `Couldn't restore this location. Nothing was changed — please try again.\n\n${String((e as Error)?.message ?? e)}`);
              return;
            }
            setLocation(getLocationById(id));
          },
        },
      ]
    );
  }

  // ── Archive handler (existing, now with logging) ────────────────────────────

  async function handleArchive() {
    if (!location) return;
    const ok = await confirmSheet({
      title: 'Archive Location',
      message: `Archive "${location.name}"? It will be hidden from active lists.`,
      confirmLabel: 'Archive',
      destructive: true,
    });
    if (!ok) return;
    const now = new Date().toISOString();
    try {
      runInTransaction(() => {
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
      });
    } catch (e) {
      Alert.alert('Archive failed', `Couldn't archive this location. Nothing was changed — please try again.\n\n${String((e as Error)?.message ?? e)}`);
      return;
    }
    // Navigate away only after the archive actually committed.
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ title: location.name, headerShown: true }} />
      <ScrollView contentContainerStyle={s.content}>

        {/* ── Header card ─────────────────────────────────────────────────── */}
        <Card variant="detail">
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
          {!!location.type && (
            <KeyValueRow
              label="Type"
              value={`${renderIcon(typeIconByLabel.get(location.type) ?? null)} ${location.type}`}
            />
          )}
          {!!parentName && <KeyValueRow label="Sub-area of" value={parentName} />}
          {!!ownerName && <KeyValueRow label="Owner" value={ownerName} />}
        </Card>

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
          {canAddStock && location.active === 1 && (
            <TouchableOpacity
              style={s.addStockBtn}
              onPress={() => router.push({ pathname: '/(app)/(inventory)/add', params: { locationId: id } })}
            >
              <Text style={s.addStockBtnText}>+ Add Stock Here</Text>
            </TouchableOpacity>
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

        {/* ── Shelves ──────────────────────────────────────────────────────── */}
        {/* Shelves are a sub-level of this location, not first-class locations, so
            they're hidden from the Locations browser — this is their home screen.
            Shown whenever the flag is on OR shelves already exist (e.g. the flag
            was turned off after shelves were created). */}
        {(location.has_shelves === 1 || shelves.length > 0) && (
          <>
            <Text style={s.sectionLabel}>Shelves</Text>
            <View style={s.card}>
              {shelves.length === 0 ? (
                <Text style={s.muted}>
                  No shelves yet. Typing a new shelf name while adding stock here creates one.
                </Text>
              ) : (
                shelves.map((shelf, i) => (
                  <View key={shelf.id}>
                    <View style={[s.shelfRow, i < shelves.length - 1 && coloringShelfId !== shelf.id && s.divider]}>
                      <View style={s.shelfRowMain}>
                        <View style={[s.shelfColorDot, { backgroundColor: shelf.color ?? colors.border }]} />
                        <View style={{ flex: 1 }}>
                          <Text style={s.shelfName}>{shelf.name}</Text>
                          <Text style={s.shelfParent}>{location.name}</Text>
                        </View>
                      </View>
                      {canManage && (
                        <TouchableOpacity
                          onPress={() => setColoringShelfId(prev => (prev === shelf.id ? null : shelf.id))}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Text style={s.shelfColorBtn}>Color</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    {coloringShelfId === shelf.id && (
                      <View style={[s.colorRow, i < shelves.length - 1 && s.divider, { paddingBottom: 10 }]}>
                        <TouchableOpacity
                          style={[s.colorCell, s.colorCellNone, shelf.color === null && s.colorCellActive]}
                          onPress={() => handleSetShelfColor(shelf.id, null)}
                        >
                          <Text style={s.colorCellNoneText}>✕</Text>
                        </TouchableOpacity>
                        {COLOR_OPTIONS.map(c => (
                          <TouchableOpacity
                            key={c}
                            style={[s.colorCell, { backgroundColor: c }, shelf.color === c && s.colorCellActive]}
                            onPress={() => handleSetShelfColor(shelf.id, c)}
                          >
                            {shelf.color === c && <Text style={s.colorCheck}>✓</Text>}
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                ))
              )}
            </View>
          </>
        )}

        {/* ── Report repair (vehicles only) ───────────────────────────────── */}
        {canAddStock && location.type === 'Vehicle' && location.active === 1 && (
          <TouchableOpacity
            style={[s.card, s.reportRepairRow]}
            onPress={() => router.push({
              pathname: '/(app)/(repairs)/new',
              params: { entityType: 'location', entityId: location.id, entityLabel: location.name },
            })}
          >
            <Text style={s.reportRepairText}>🔧 Report repair</Text>
            <Text style={s.attrVal}>›</Text>
          </TouchableOpacity>
        )}

        {/* ── Print QR label ──────────────────────────────────────────────── */}
        <TouchableOpacity style={[s.card, s.attrRow]} onPress={() => setShowPrintLabel(true)}>
          <Text style={s.attrKey}>🏷 Print QR Label</Text>
          <Text style={s.attrVal}>›</Text>
        </TouchableOpacity>

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
            <FilterChip
              label="⌂ Top level (no parent)"
              active={editParentId === null}
              onPress={() => setEditParentId(null)}
            />
            <SearchablePicker
              placeholder="…or nest inside a location"
              options={parentOptions}
              value={editParentId ? { id: editParentId, label: getLocationPath(editParentId) } : null}
              // Tapping "Change" re-passes the current id — treat as clear so the
              // search reopens and a different parent can be picked.
              onSelect={(opt) => setEditParentId(prev => (prev === opt.id ? null : opt.id))}
            />

            {locationTypes.length > 0 && (
              <>
                <FieldLabel>Type</FieldLabel>
                <View style={s.chipRow}>
                  {locationTypes.map(t => (
                    <FilterChip
                      key={t.id}
                      label={t.icon ? `${t.icon} ${t.label}` : t.label}
                      active={editLocType === t.label}
                      onPress={() => {
                        // Toggle off when re-tapping the active type.
                        if (editLocType === t.label) { setEditLocType(null); return; }
                        setEditLocType(t.label);
                        // Auto-apply the type's icon (user can still change it below).
                        if (t.icon) setEditIcon(t.icon);
                      }}
                    />
                  ))}
                </View>
              </>
            )}

            <FieldLabel>{ownerRequired ? 'Belongs to (required)' : 'Belongs to (optional)'}</FieldLabel>
            {/* UserPicker treats re-selecting the current person as clear. */}
            <UserPicker
              placeholder="Search people…"
              value={editOwnerOption}
              onChange={setEditOwnerOption}
            />
            {ownerMissing && (
              <Text style={s.ownerError}>
                This sub-area's parent requires an owner — pick a person to save.
              </Text>
            )}

            {/* GPS anchor hidden for types whose rules disable it (Vehicle/Locker/…). */}
            {rules.gps && (
              <>
                <FieldLabel>GPS Anchor</FieldLabel>
                <GpsAnchorField
                  value={editLatitude !== null && editLongitude !== null ? { latitude: editLatitude, longitude: editLongitude } : null}
                  onChange={(c) => { setEditLatitude(c?.latitude ?? null); setEditLongitude(c?.longitude ?? null); }}
                  disabled={locked}
                />
              </>
            )}

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

            <View style={s.switchRow}>
              <Text style={s.switchLabel}>Has shelves (type a shelf when adding stock here)</Text>
              <Switch value={editHasShelves} onValueChange={setEditHasShelves} disabled={locked} />
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

      {/* ── Print QR Label (location) ────────────────────────────────────────── */}
      <LabelPrintSheet
        visible={showPrintLabel}
        onClose={() => setShowPrintLabel(false)}
        title={location.name}
        code={`INV:location:${id}`}
        qrUrl={`${API}/labels/location/${id}/qr.png`}
      />

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
  addStockBtn: {
    marginTop: spacing.md, paddingVertical: 12, alignItems: 'center',
    backgroundColor: colors.primary, borderRadius: radii.md,
  },
  addStockBtnText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

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
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  iconCell: { width: 46, height: 46, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  iconCellActive: { borderColor: colors.primary, backgroundColor: colors.primaryBgStrong },
  iconCellText: { fontSize: 22 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorCell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  colorCellActive: { borderColor: colors.textPrimary },
  colorCheck: { color: '#fff', fontWeight: '800', fontSize: fontSizes.base },
  colorCellNone: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  colorCellNoneText: { color: colors.textMuted, fontWeight: '800', fontSize: fontSizes.body },

  // ── Shelves section ────────────────────────────────────────────────────────
  shelfRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: spacing.sm,
  },
  shelfRowMain: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  shelfColorDot: { width: 14, height: 14, borderRadius: 7 },
  shelfName: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  shelfParent: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: 1 },
  shelfColorBtn: { color: colors.primary, fontWeight: '700', fontSize: fontSizes.body2 },
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
  reportRepairRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
  reportRepairText: { fontSize: fontSizes.body, color: colors.textSecondary, fontWeight: '600' },
});
