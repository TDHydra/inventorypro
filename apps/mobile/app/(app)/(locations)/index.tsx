import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import {
  getLocationTree, upsertLocation, getLocationById, getAllLocations, getLocationPath,
  LocationWithChildren,
} from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { appendLog } from '../../../src/db/queries/log';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { MediaThumbnail } from '../../../src/components/MediaThumbnail';
import { GpsAnchorField } from '../../../src/components/GpsAnchorField';
import { getLocationTypes } from '../../../src/db/queries/taxonomy';
import { ICON_OPTIONS, COLOR_OPTIONS, renderIcon } from '../../../src/constants/locationStyles';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { syncNow } from '../../../src/sync/engine';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';

export default function LocationsScreen() {
  const canManage = usePermission('manage_locations');
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const [tree, setTree] = useState<LocationWithChildren[]>(() => getLocationTree());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);

  // Location-type taxonomy (Shop, Vehicle, Locker, …) for the create-form picker,
  // the list section filter, and per-row type badges. Active types only.
  const locationTypes = useMemo(() => getLocationTypes(), []);
  // label → icon, used to render a row's type badge from its stored `type` label.
  const typeIconByLabel = useMemo(
    () => new Map(locationTypes.map(t => [t.label, t.icon])),
    [locationTypes],
  );
  // Section filter: null = All (show full tree); a label = flat list of that type.
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  // Create form state
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [icon, setIcon] = useState(ICON_OPTIONS[0]);
  const [ownerOption, setOwnerOption] = useState<PickerOption | null>(null);
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);

  // Pull-to-refresh
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    setTree(getLocationTree());
    setRefreshing(false);
  }, [refreshing]);

  // All active locations as parent options, labelled by full path (e.g.
  // "Site A › Floor 2"). Locations are a bounded set, so client-side filtering in
  // the picker is fine (unlike the 1000+ item catalog).
  const parentOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: getLocationPath(l.id) })),
    [tree],
  );

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
    // Siblings = locations sharing the chosen parent (works at any depth).
    const siblings = getAllLocations().filter(l => (l.parent_id ?? null) === parentId);
    return siblings.find(l => l.name.trim().toLowerCase() === n) ?? null;
  }, [name, parentId, tree]);

  // Conditional Owner: when the chosen parent has "subareas require an owner"
  // on, an owner must be picked before the sub-area can be created.
  const parentRequiresOwner = useMemo(
    () => (parentId ? !!getLocationById(parentId)?.subareas_require_owner : false),
    [parentId],
  );

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function resetForm() {
    setName(''); setParentId(null); setType(null); setColor(COLOR_OPTIONS[0]); setIcon(ICON_OPTIONS[0]); setOwnerOption(null);
    setLatitude(null); setLongitude(null);
  }

  function openCreate(presetParent: string | null = null) {
    resetForm();
    setParentId(presetParent);
    setShowCreate(true);
  }

  function doCreate() {
    if (isWriteBlocked()) return;
    const id = generateUUID();
    const now = new Date().toISOString();
    const trimmed = name.trim();
    const payload = {
      id, name: trimmed, parent_id: parentId,
      type: type ?? null,
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
    if (parentRequiresOwner && !ownerOption) {
      Alert.alert('Owner required', `Sub-areas under "${parentName}" must have an owner. Pick one under "Owner".`);
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

  const parentName = parentId ? (getLocationPath(parentId) || 'location') : null;

  // When a type filter is active we show a flat list (across the whole tree) of
  // matching locations instead of the nested tree, giving Vehicles/Lockers/etc.
  // "sections".
  const filteredLocations = useMemo(
    () => (typeFilter ? getAllLocations().filter(l => l.type === typeFilter) : []),
    [typeFilter, tree],
  );

  // Flat card for a single location (used by the type-filtered view).
  function renderFlatCard(loc: typeof filteredLocations[number]) {
    return (
      <View key={loc.id} style={s.card}>
        <TouchableOpacity
          style={s.cardInner}
          onPress={() => router.push({ pathname: '/(app)/(locations)/[id]', params: { id: loc.id } })}
          activeOpacity={0.7}
        >
          <MediaThumbnail entityType="location" entityId={loc.id} size={40} />
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{loc.name}</Text>
            {!!loc.type && (
              <Text style={s.typeMeta}>
                {renderIcon(typeIconByLabel.get(loc.type) ?? null)} {loc.type}
              </Text>
            )}
            {!!getLocationPath(loc.id) && getLocationPath(loc.id) !== loc.name && (
              <Text style={s.meta} numberOfLines={1}>{getLocationPath(loc.id)}</Text>
            )}
            {!!loc.owner_user_id && (
              <Text style={s.ownerMeta}>Owner: {userMap.get(loc.owner_user_id) ?? loc.owner_user_id}</Text>
            )}
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  // Recursive tree node — renders a location card indented by depth, an
  // expand/collapse chevron when it has children, and (when open) its children
  // recursively + an "Add sub-area" affordance at any level.
  function renderNode(node: LocationWithChildren) {
    const isOpen = expanded.has(node.id);
    const hasKids = node.children.length > 0;
    // Expandable when it has children, or when a manager could add one — so any
    // node can be opened to nest a sub-area under it.
    const expandable = hasKids || canManage;
    return (
      <View key={node.id} style={[s.group, node.depth > 0 && { marginLeft: 16 }]}>
        <View style={s.card}>
          <TouchableOpacity
            style={s.cardInner}
            onPress={() => router.push({ pathname: '/(app)/(locations)/[id]', params: { id: node.id } })}
            activeOpacity={0.7}
          >
            <MediaThumbnail entityType="location" entityId={node.id} size={node.depth > 0 ? 30 : 40} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{node.name}</Text>
              {!!node.type && (
                <Text style={s.typeMeta}>
                  {renderIcon(typeIconByLabel.get(node.type) ?? null)} {node.type}
                </Text>
              )}
              <Text style={s.meta}>
                {hasKids
                  ? `${node.children.length} sub-area${node.children.length === 1 ? '' : 's'}`
                  : 'No sub-areas'}
              </Text>
              {!!node.owner_user_id && (
                <Text style={s.ownerMeta}>Owner: {userMap.get(node.owner_user_id) ?? node.owner_user_id}</Text>
              )}
            </View>
          </TouchableOpacity>
          {expandable && (
            <TouchableOpacity
              onPress={() => toggle(node.id)}
              style={s.expandBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={s.chevron}>{isOpen ? '▾' : '▸'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {isOpen && (
          <View style={s.children}>
            {node.children.map(child => renderNode(child))}
            {canManage && (
              <TouchableOpacity style={s.addSub} onPress={() => openCreate(node.id)}>
                <Text style={s.addSubText}>+ Add sub-area</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    );
  }

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

        <TooltipHint screenKey="locations" />

        {locationTypes.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.filterRow}
            style={s.filterRowWrap}
          >
            <FilterChip label="All" active={typeFilter === null} onPress={() => setTypeFilter(null)} />
            {locationTypes.map(t => (
              <FilterChip
                key={t.id}
                label={t.icon ? `${t.icon} ${t.label}` : t.label}
                active={typeFilter === t.label}
                onPress={() => setTypeFilter(prev => (prev === t.label ? null : t.label))}
              />
            ))}
          </ScrollView>
        )}

        <ScrollView
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
        >
          {tree.length === 0 && (
            <Text style={s.empty}>
              No locations yet.{canManage ? ' Tap "+ New" to add your first warehouse, shop, or van.' : ''}
            </Text>
          )}

          {typeFilter ? (
            filteredLocations.length === 0 ? (
              <Text style={s.empty}>No {typeFilter} locations.</Text>
            ) : (
              filteredLocations.map(loc => renderFlatCard(loc))
            )
          ) : (
            tree.map(node => renderNode(node))
          )}
        </ScrollView>

        {/* Create modal — onClose ONLY hides the sheet; inputs preserved on outside-tap dismiss.
            Reset happens in: Clear button (resetForm) and successful submit (doCreate calls resetForm). */}
        <ModalSheet visible={showCreate} onClose={() => setShowCreate(false)}>
            <Text style={s.modalTitle}>
              {parentName ? `New sub-area in ${parentName}` : 'New location'}
            </Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <AppInput
                placeholder="Location name *"
                value={name}
                onChangeText={setName}
                autoFocus
              />
              {!!dup && (
                <Text style={s.dupWarn}>⚠ "{dup.name}" already exists here</Text>
              )}

              {locationTypes.length > 0 && (
                <>
                  <FieldLabel>Type</FieldLabel>
                  <View style={s.chipRow}>
                    {locationTypes.map(t => (
                      <FilterChip
                        key={t.id}
                        label={t.icon ? `${t.icon} ${t.label}` : t.label}
                        active={type === t.label}
                        onPress={() => setType(prev => (prev === t.label ? null : t.label))}
                      />
                    ))}
                  </View>
                </>
              )}

              <AdvancedFields>
                <FieldLabel>Inside</FieldLabel>
                <FilterChip
                  label="⌂ Top level (no parent)"
                  active={parentId === null}
                  onPress={() => setParentId(null)}
                />
                <SearchablePicker
                  placeholder="…or nest inside a location"
                  options={parentOptions}
                  value={parentId ? { id: parentId, label: getLocationPath(parentId) } : null}
                  // Tapping "Change" re-passes the current id — treat as clear so the
                  // search reopens and a different parent can be picked.
                  onSelect={(opt) => setParentId(prev => (prev === opt.id ? null : opt.id))}
                />

                <FieldLabel>{parentRequiresOwner ? 'Owner *' : 'Belongs to (optional)'}</FieldLabel>
                <SearchablePicker
                  placeholder="Search people…"
                  options={userOptions}
                  value={ownerOption}
                  onSelect={(opt) => {
                    // Tapping "Change" re-passes current value — treat as clear
                    setOwnerOption(prev => (prev?.id === opt.id ? null : opt));
                  }}
                />
                {parentRequiresOwner && !ownerOption && (
                  <Text style={s.dupWarn}>⚠ Sub-areas here require an owner.</Text>
                )}

                <FieldLabel>GPS Anchor</FieldLabel>
                <GpsAnchorField
                  value={latitude !== null && longitude !== null ? { latitude, longitude } : null}
                  onChange={(c) => { setLatitude(c?.latitude ?? null); setLongitude(c?.longitude ?? null); }}
                  disabled={locked}
                />

                <FieldLabel>Icon</FieldLabel>
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

                <FieldLabel>Color</FieldLabel>
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
              </AdvancedFields>

              <PrimaryButton label="Add Location" onPress={handleSave} disabled={locked} style={{ marginTop: spacing.sm }} />
              {locked && <MaintenanceBanner />}
              <View style={s.secondaryRow}>
                <TouchableOpacity style={s.linkBtn} onPress={resetForm}>
                  <Text style={s.linkText}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.linkBtn} onPress={() => { setShowCreate(false); resetForm(); }}>
                  <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
        </ModalSheet>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  subtitle: { fontSize: fontSizes.body2, color: colors.textSecondary, fontWeight: '600' },
  addBtn: { backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
  filterRowWrap: { flexGrow: 0, maxHeight: 52 },
  filterRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  list: { padding: spacing.lg, paddingTop: spacing.xs, gap: 10, paddingBottom: 48 },
  empty: { textAlign: 'center', color: colors.textMuted, fontSize: fontSizes.md, marginTop: 48, paddingHorizontal: 24, lineHeight: 22 },

  group: { gap: 0 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.md, gap: spacing.md, borderWidth: 1, borderColor: colors.border },
  cardInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  expandBtn: { paddingHorizontal: 4, paddingVertical: 4 },
  swatch: { width: 42, height: 42, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  swatchIcon: { fontSize: 20 },
  name: { fontSize: fontSizes.base, fontWeight: '600', color: colors.textPrimary },
  typeMeta: { fontSize: fontSizes.sm, color: colors.textSecondary, fontWeight: '600', marginTop: 2 },
  meta: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: 2 },
  ownerMeta: { fontSize: fontSizes.sm, color: colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: fontSizes.lg, color: colors.textMuted, paddingHorizontal: 4 },

  children: { marginLeft: 20, marginTop: 6, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.border, gap: 6 },
  addSub: { paddingVertical: 6, paddingHorizontal: 2 },
  addSubText: { color: colors.primary, fontSize: fontSizes.body2, fontWeight: '600' },

  // Modal content (overlay + sheet handled by ModalSheet primitive)
  modalTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.base },
  dupWarn: { color: colors.warning, fontSize: fontSizes.body2, fontWeight: '600' },
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
});
