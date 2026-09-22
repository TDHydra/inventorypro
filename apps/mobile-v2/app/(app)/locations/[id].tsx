// Ported from apps/mobile/app/(app)/(locations)/[id].tsx.
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/locations' → '../../../src/repos/locations'
//   '../../../src/db/queries/taxonomy'  → '../../../src/repos/taxonomy'
//   '../../../src/sync/outbox' (appendOutbox) → dropped; repos/locations.ts
//     self-mirrors to the outbox via createRepository/mirror.
//   '../../../src/db/tx' (runInTransaction) → '@invenpro/core'
//   '../../../src/hooks/useFocusOrDataRefresh' → dropped; replaced with
//     '@invenpro/core''s useDbQuery, which is already reactive to local writes
//     AND sync pulls on the subscribed tables (#60/#63) — no separate
//     focus-refresh plumbing needed.
//   '../../../src/lib/themedAlert' (Alert), ConfirmSheet's confirmSheet, ui/*
//     components, useTheme, useThemedStyles → '@invenpro/ui'
//   '/(app)/(locations)/[id]' route → '/(app)/locations/[id]'
//   '/(app)/(inventory)/add' route → '/(app)/quickadd/[sheet]' sheet=stock
//     (add.tsx wasn't ported; the stock sheet reads the locationId param)
//   '/(app)/(repairs)/new' route → cast `as never` (TODO(wave-C), matches the
//     existing pattern in src/components/ItemCard.tsx)
//
// Slimmed per the rulebook — cut, each with a TODO marker / repo-owned note:
//   - MediaGallery (photos section): TODO(wave-media), matches ItemCard.
//   - LabelPrintSheet ("Print QR Label" row + sheet): TODO(wave-B) — component
//     not ported to src/components yet (168 ln in the old app); out of scope
//     for this locations-only port (src/components/** is shared, not owned
//     here). Reported to the coordinator as a shared-component gap.
//   - ActivityFeed (Activity section): TODO(wave-B) — same reasoning, not
//     ported to src/components yet (236 ln); reported as a shared-component gap.
//   - VehiclePanel / LockerPanel (type-conditional embeds): TODO(wave-B) —
//     both live under src/components/{vehicles,lockers}/, neither ported
//     (498 + 208 ln); the vehicles/lockers domain itself isn't ported either
//     (see the PORT NOTE atop repos/locations.ts). The header card's Type row
//     still shows "Vehicle"/"Locker" via the taxonomy label.
//   - Vehicle-type Archive: hidden (retireVehicle needs the unported
//     vehicles.ts domain — see repos/locations.ts's archiveLocation doc
//     comment). Vehicle-type Restore/reactivation IS kept working
//     (reactivateVehicle, already ported).
// Kept fully working: shelf colors, GPS anchor, type/subtype taxonomy, the
// rooms (sub-areas) section (repos/locations.ts::getRoomsForParent — NOT the
// unrelated src/repos/rooms.ts room-catalog table used for job-photo tagging),
// map picker (via GpsAnchorField → MapPickerModal, already ported), Move Stock.
import { useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  Alert, confirmSheet, useTheme, useThemedStyles,
  ModalSheet, PrimaryButton, AppInput, FieldLabel, FilterChip, Card, KeyValueRow, MaintenanceBanner,
} from '@invenpro/ui';
import { useDbQuery, runInTransaction } from '@invenpro/core';
import {
  getLocationById, getStockAtLocation, upsertLocation,
  getBrowsableLocations, getLocationPath, getDescendantIds,
  getShelvesForParent, setShelfColor, getRoomsForParent, findOrCreateShelf,
  reactivateVehicle, archiveLocation, restoreLocation,
  StockAtLocation, Location,
} from '../../../src/repos/locations';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { getAllActiveUsers } from '../../../src/repos/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { UserPicker } from '../../../src/components/pickers';
import MoveStockModal from '../../../src/components/MoveStockModal';
import { GpsAnchorField } from '../../../src/components/GpsAnchorField';
import { getLocationTypes, getLocationTypesWithFallback, getLocationSubtypes, getLocationSubtypesWithFallback, getLocationTypeRules } from '../../../src/repos/taxonomy';
import { ICON_ALIASES, ICON_OPTIONS, COLOR_OPTIONS, renderIcon } from '../../../src/constants/locationStyles';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';

export default function LocationDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('manage_locations');
  const canAddStock = usePermission('edit_inventory');
  // #197/#198: previously this screen had no view_locations check at all —
  // hub links, search results, and deep links all routed straight in
  // regardless of the role's permission. Gate the whole screen here.
  const canView = usePermission('view_locations');
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Reactive reads — re-run on any local write OR sync pull that touches the
  // subscribed tables (#60/#63); no manual refetch/refreshKey plumbing needed.
  const location = useDbQuery<Location | null>(() => getLocationById(id), [id], ['locations', 'taxonomy_types']);
  const stock = useDbQuery<StockAtLocation[]>(() => getStockAtLocation(id), [id], ['stock_by_location', 'inventory_items']);
  // This location's shelves (only relevant when has_shelves is/was on).
  const shelves = useDbQuery<Location[]>(() => getShelvesForParent(id), [id], ['locations']);
  // Non-shelf children ("rooms") for the Sub-areas section.
  const rooms = useDbQuery<Location[]>(() => getRoomsForParent(id), [id], ['locations', 'taxonomy_types']);

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

  // Location-type taxonomy for the edit picker. A SUB-AREA (has a parent) offers
  // the sub-area types (Closet, Section, Storage, Shelf, Area, Bin, Rack) — note
  // 'Shelf' IS a valid sub-area type, so it's NOT filtered out here. A TOP-LEVEL
  // location offers the location_type list (Shop, Vehicle, …) with 'Shelf'
  // filtered out defensively (it's a hardcoded sub-level type, see
  // findOrCreateShelf, never a real top-level type to re-assign to).
  const isSubArea = editParentId != null;
  const locationTypes = useDbQuery(
    () =>
      isSubArea
        ? getLocationSubtypesWithFallback()
        : getLocationTypesWithFallback().filter(t => t.label !== 'Shelf'),
    [isSubArea],
    ['taxonomy_types'],
  );
  // label→icon map (incl. archived) for rendering the header badge, built from
  // BOTH top-level and sub-area types so a sub-area's badge icon resolves too.
  const typeIconByLabel = useDbQuery(
    () => new Map([
      ...getLocationTypes({ includeInactive: true }).map(t => [t.label, t.icon] as const),
      ...getLocationSubtypes({ includeInactive: true }).map(t => [t.label, t.icon] as const),
    ]),
    [],
    ['taxonomy_types'],
  );

  const allUsers = useDbQuery(() => getAllActiveUsers(), [], ['users']);
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
  const parentOptions = useDbQuery<PickerOption[]>(() => {
    const blocked = getDescendantIds(id);
    return getBrowsableLocations()
      .filter(l => !blocked.has(l.id))
      .map(l => ({ id: l.id, label: getLocationPath(l.id) }));
  }, [id], ['locations']);

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
    // No explicit reload: setShelfColor's write bumps 'locations', which the
    // useDbQuery(shelves) read above is subscribed to.
    setColoringShelfId(null);
  }

  // Inline "+ Add shelf" on the Shelves card. findOrCreateShelf is transactional
  // (upsert + outbox atomic) and dedupes case-insensitively; null means failure
  // per its contract, so nothing was changed.
  const [newShelfName, setNewShelfName] = useState('');
  function handleAddShelf() {
    const trimmed = newShelfName.trim();
    if (!trimmed || isWriteBlocked()) return;
    const createdId = findOrCreateShelf(id, trimmed);
    if (createdId === null) {
      Alert.alert('Add failed', `Couldn't create shelf "${trimmed}". Nothing was changed — please try again.`);
      return;
    }
    setNewShelfName('');
  }

  // Per-location-type form rules (migration 022): gps (show the GPS anchor) and
  // requiresOwner (force an owner). Defaults gps=true/requiresOwner=false. A
  // SUB-AREA lives inside a parent, so it has no separate GPS anchor of its own —
  // force gps=false (owner requirement still comes from the parent below).
  const rules = isSubArea ? { gps: false, requiresOwner: false } : getLocationTypeRules(editLocType);
  // Owner becomes mandatory when the selected parent has subareas_require_owner=1
  // OR the chosen type requires it (e.g. Vehicle). Reactive to editParentId and
  // editLocType so re-parenting/retyping updates the gate.
  const ownerRequired = useDbQuery<boolean>(() => {
    const parentReq = editParentId ? getLocationById(editParentId)?.subareas_require_owner === 1 : false;
    // Sub-area types carry no requiresOwner rule of their own; the parent's flag
    // is the only owner gate for a sub-area.
    const typeReq = isSubArea ? false : getLocationTypeRules(editLocType).requiresOwner;
    return parentReq || typeReq;
  }, [editParentId, editLocType, isSubArea], ['locations', 'taxonomy_types']);
  const ownerMissing = ownerRequired && !editOwnerOption;

  const parentName = useDbQuery<string | null>(() => {
    if (!location?.parent_id) return null;
    // Full ancestor path of the parent (e.g. "Site A › Floor 2").
    return getLocationPath(location.parent_id) || null;
  }, [location?.parent_id], ['locations']);

  const ownerName = useMemo<string | null>(() => {
    if (!location?.owner_user_id) return null;
    return userMap.get(location.owner_user_id) ?? location.owner_user_id;
  }, [location?.owner_user_id, userMap]);

  // Permission gate checked before "not found" so a denied role never learns
  // whether the id even resolves to a real location.
  if (!canView) {
    return (
      <>
        <Stack.Screen options={{ title: 'Location', headerShown: true }} />
        <PermissionGate permission="view_locations" mode="screen" />
      </>
    );
  }

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
    // Atomic: local row upsert (mirrored to the outbox by upsertLocation) + log
    // either all land or none do. runInTransaction is reentrant — upsertLocation
    // opens its own transaction internally and joins this outer one.
    try {
      runInTransaction(() => {
        upsertLocation({
          ...location, ...changes,
          subareas_require_owner: editRequireOwner ? 1 : 0,
          has_shelves: editHasShelves ? 1 : 0,
          active: 1, updated_at: now, synced_at: null,
        });
        appendLog({
          action: 'location_updated',
          entity_type: 'location',
          entity_id: id,
          user_id: realUser?.id ?? null,
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
            // #153: a Vehicle can reach this generic screen too (QR scan,
            // repair link, search) — route through reactivateVehicle so it
            // stays consistent with the dedicated vehicle-panel action rather
            // than a second, divergent raw-UPDATE write path.
            if (location.type === 'Vehicle') {
              const res = reactivateVehicle(id, user?.id ?? null);
              if (!res.ok) { Alert.alert('Restore failed', res.reason); }
              return;
            }
            try {
              restoreLocation(id, realUser?.id ?? null);
            } catch (e) {
              Alert.alert('Restore failed', `Couldn't restore this location. Nothing was changed — please try again.\n\n${String((e as Error)?.message ?? e)}`);
            }
          },
        },
      ]
    );
  }

  // ── Archive handler ──────────────────────────────────────────────────────────

  async function handleArchive() {
    if (!location) return;
    const ok = await confirmSheet({
      title: 'Archive Location',
      message: `Archive "${location.name}"? It will be hidden from active lists.`,
      confirmLabel: 'Archive',
      destructive: true,
    });
    if (!ok) return;
    // Vehicle-type archiving is NOT offered here (see the button's guard below
    // and the doc comment on archiveLocation in repos/locations.ts) — it needs
    // retireVehicle's open-checkout guard from the unported vehicles.ts domain.
    try {
      archiveLocation(id, realUser?.id ?? null);
    } catch (e) {
      Alert.alert('Archive failed', `Couldn't archive this location. Nothing was changed — please try again.\n\n${String((e as Error)?.message ?? e)}`);
      return;
    }
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

        {/* TODO(wave-B): VehiclePanel / LockerPanel embeds not ported yet —
            src/components/{vehicles,lockers}/ don't exist in mobile-v2, and the
            vehicles/lockers domain itself isn't ported (see the PORT NOTE atop
            repos/locations.ts). The header Type row above still shows
            "Vehicle"/"Locker". Reported as a shared-component gap. */}

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
              onPress={() => router.push({
                // add.tsx wasn't ported — the stock quick-add sheet reads the
                // locationId param and pre-selects this location.
                pathname: '/(app)/quickadd/[sheet]',
                params: { sheet: 'stock', locationId: id },
              })}
            >
              <Text style={s.addStockBtnText}>+ Add Stock Here</Text>
            </TouchableOpacity>
          )}
          {/* server enforces edit_inventory via stock_by_location for moves,
              not manage_locations (#76) — reuse canAddStock, already the same
              permission check used for "+ Add Stock Here" above. */}
          {canAddStock && stock.length > 0 && (
            <TouchableOpacity
              style={s.moveStockBtn}
              onPress={() => setShowMoveStock(true)}
            >
              <Text style={s.moveStockBtnText}>Move Stock</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Sub-areas (rooms) ───────────────────────────────────────────── */}
        {/* Non-shelf children — the rooms of a building. Units (Vehicle/Locker)
            can't contain rooms (A1's server guard), so the affordance is gated. */}
        {(rooms.length > 0 || (canManage && location.active === 1 && location.type !== 'Vehicle' && location.type !== 'Locker')) && (
          <>
            <Text style={s.sectionLabel}>Sub-areas</Text>
            <View style={s.card}>
              {rooms.length === 0 ? (
                <Text style={s.muted}>No sub-areas yet. Add rooms (e.g. Maintenance Room, Product Room, Garage) to organize this place.</Text>
              ) : (
                rooms.map((room, i) => (
                  <TouchableOpacity
                    key={room.id}
                    style={[s.stockRow, i < rooms.length - 1 && s.divider]}
                    onPress={() => router.push({ pathname: '/(app)/locations/[id]', params: { id: room.id } })}
                  >
                    <Text style={s.stockName} numberOfLines={1}>
                      {room.type ? `${renderIcon(typeIconByLabel.get(room.type) ?? null)} ` : ''}{room.name}
                    </Text>
                    <Text style={s.attrVal}>›</Text>
                  </TouchableOpacity>
                ))
              )}
              {canManage && location.active === 1 && location.type !== 'Vehicle' && location.type !== 'Locker' && (
                <TouchableOpacity
                  style={s.addStockBtn}
                  onPress={() => router.push({ pathname: '/(app)/locations', params: { createUnder: id } })}
                >
                  <Text style={s.addStockBtnText}>+ Add Sub-area</Text>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}

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
                  No shelves yet. Add one below, or type a new shelf name while adding stock here.
                </Text>
              ) : (
                shelves.map((shelf, i) => (
                  <View key={shelf.id}>
                    <View style={[s.shelfRow, i < shelves.length - 1 && coloringShelfId !== shelf.id && s.divider]}>
                      <View style={s.shelfRowMain}>
                        <View style={[s.shelfColorDot, { backgroundColor: shelf.color ?? t.colors.border }]} />
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
              {canManage && location.active === 1 && location.has_shelves === 1 && (
                <View style={s.addShelfRow}>
                  <View style={{ flex: 1 }}>
                    <AppInput placeholder="New shelf name (e.g. A1)" value={newShelfName} onChangeText={setNewShelfName} />
                  </View>
                  <TouchableOpacity onPress={handleAddShelf} disabled={locked || !newShelfName.trim()} style={s.addShelfBtn}>
                    <Text style={s.addShelfBtnText}>+ Add</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </>
        )}

        {/* ── Report repair (vehicles only) ───────────────────────────────── */}
        {canAddStock && location.type === 'Vehicle' && location.active === 1 && (
          <TouchableOpacity
            style={[s.card, s.reportRepairRow]}
            onPress={() => router.push({
              // TODO(wave-C): repairs surface isn't built yet — cast bypasses
              // expo-router's typed-routes check until that screen lands.
              pathname: '/(app)/repairs/new',
              params: { entityType: 'location', entityId: location.id, entityLabel: location.name },
            } as never)}
          >
            <Text style={s.reportRepairText}>🔧 Report repair</Text>
            <Text style={s.attrVal}>›</Text>
          </TouchableOpacity>
        )}

        {/* TODO(wave-B): Print QR Label row/sheet not ported — LabelPrintSheet
            (src/components/LabelPrintSheet.tsx in the old app, 168 ln) isn't in
            mobile-v2 yet. Reported as a shared-component gap. */}

        {/* TODO(wave-media): Photos section (MediaGallery) not ported yet,
            matches src/components/ItemCard.tsx's MediaThumbnail cut. */}

        {/* TODO(wave-B): Activity section (ActivityFeed) not ported —
            src/components/ActivityFeed.tsx in the old app (236 ln) isn't in
            mobile-v2 yet. Reported as a shared-component gap. */}

        {/* ── Unarchive button ─────────────────────────────────────────────── */}
        {canManage && location.active === 0 && (
          <TouchableOpacity style={[s.btn, s.btnRestore]} onPress={handleUnarchive}>
            <Text style={s.btnRestoreText}>Restore Location</Text>
          </TouchableOpacity>
        )}

        {/* ── Archive button ───────────────────────────────────────────────── */}
        {/* Vehicle-type archiving needs retireVehicle's open-checkout guard
            (unported vehicles.ts domain — see repos/locations.ts's
            archiveLocation doc comment) — hidden here until that lands. */}
        {canManage && location.active === 1 && location.type !== 'Vehicle' && (
          <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={handleArchive}>
            <Text style={s.btnDangerText}>Archive Location</Text>
          </TouchableOpacity>
        )}

      </ScrollView>

      {/* ── Edit Modal — onClose ONLY hides the sheet; edit inputs are preserved on
          outside-tap dismiss. Form is re-populated on openEdit(); no explicit Clear exists. ── */}
      <ModalSheet visible={showEdit} onClose={() => setShowEdit(false)} scroll={false}>
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
              style={{ marginTop: t.spacing.sm }}
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
        onDone={() => setShowMoveStock(false)}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: t.spacing.lg, gap: t.spacing.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted },

  card: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.lg, padding: t.spacing.lg,
    borderWidth: 1, borderColor: t.colors.borderDetail,
  },

  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: t.typography.fontSizes.xl, fontWeight: '700', color: t.colors.brand, flex: 1 },
  editBtn: { paddingHorizontal: t.spacing.md, paddingVertical: 6, backgroundColor: t.colors.primaryBg, borderRadius: t.radii.sm },
  editBtnText: { color: t.colors.primary, fontWeight: '700', fontSize: t.typography.fontSizes.body2 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary },
  attrVal: {
    fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600',
    maxWidth: '60%', textAlign: 'right',
  },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },

  sectionLabel: {
    fontSize: t.typography.fontSizes.caption, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },

  stockRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: t.spacing.md,
  },
  stockName: { fontSize: t.typography.fontSizes.md, color: t.colors.textPrimary, fontWeight: '500', flex: 1, marginRight: t.spacing.sm },
  stockQty: { fontSize: t.typography.fontSizes.md, fontWeight: '700', color: t.colors.success },

  moveStockBtn: {
    marginTop: t.spacing.md, paddingVertical: 10, alignItems: 'center',
    backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md,
  },
  moveStockBtnText: { color: t.colors.primary, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  addStockBtn: {
    marginTop: t.spacing.md, paddingVertical: 12, alignItems: 'center',
    backgroundColor: t.colors.primary, borderRadius: t.radii.md,
  },
  addStockBtnText: { color: t.colors.onPrimary, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  addShelfRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginTop: t.spacing.md },
  addShelfBtn: { backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: 10 },
  addShelfBtnText: { color: t.colors.primary, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },

  btn: { borderRadius: t.radii.lg, paddingVertical: 13, alignItems: 'center', marginTop: t.spacing.sm },
  btnDanger: { backgroundColor: t.colors.dangerBg },
  btnDangerText: { color: t.colors.danger, fontWeight: '700', fontSize: t.typography.fontSizes.base },
  btnRestore: { backgroundColor: '#DCFCE7' },
  btnRestoreText: { color: t.colors.success, fontWeight: '700', fontSize: t.typography.fontSizes.base },

  archivedBanner: {
    backgroundColor: t.colors.warningBg, borderRadius: t.radii.sm,
    paddingHorizontal: 10, paddingVertical: 4,
    marginBottom: 10, alignSelf: 'flex-start',
  },
  archivedText: { color: t.colors.warningText, fontWeight: '700', fontSize: t.typography.fontSizes.caption },

  // ── Edit Modal (overlay + sheet handled by ModalSheet primitive) ──────────
  modalTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.base },
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  iconCell: { width: 46, height: 46, borderRadius: t.radii.md, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border, alignItems: 'center', justifyContent: 'center' },
  iconCellActive: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBgStrong },
  iconCellText: { fontSize: 22 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorCell: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  colorCellActive: { borderColor: t.colors.textPrimary },
  colorCheck: { color: '#fff', fontWeight: '800', fontSize: t.typography.fontSizes.base },
  colorCellNone: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border },
  colorCellNoneText: { color: t.colors.textMuted, fontWeight: '800', fontSize: t.typography.fontSizes.body },

  // ── Shelves section ────────────────────────────────────────────────────────
  shelfRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: t.spacing.sm,
  },
  shelfRowMain: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flex: 1 },
  shelfColorDot: { width: 14, height: 14, borderRadius: 7 },
  shelfName: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  shelfParent: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 1 },
  shelfColorBtn: { color: t.colors.primary, fontWeight: '700', fontSize: t.typography.fontSizes.body2 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: t.spacing.sm },
  linkBtn: { paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.lg },
  linkText: { color: t.colors.primary, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
  ownerError: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  reportRepairRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14 },
  reportRepairText: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, fontWeight: '600' },
});
