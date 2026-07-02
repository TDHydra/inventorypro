import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { runInTransaction } from '../../db/tx';
import { sanitizeScan } from '../../scan/sanitize';
import { searchItems } from '../../db/queries/items';
import { upsertUnit, getUnitByTag } from '../../db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../db/queries/equipmentUnits';
import { getAllLocations, getShelvesForParent, findOrCreateShelf } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { BarcodeInput } from '../BarcodeInput';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, fontSizes, radii } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import type { QuickAddSaveMeta } from './justAdded';

interface Props {
  onSaved: (label: string, createdId?: string, meta?: QuickAddSaveMeta) => void;
}

// One row of the batch: an asset tag with its own (optional) nested serial.
interface UnitRow {
  key: string;
  assetTag: string;
  serial: string;
  error: string;
}

function newRow(assetTag = ''): UnitRow {
  return { key: generateUUID(), assetTag, serial: '', error: '' };
}

export default function EquipmentQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null); // sticky
  const [rows, setRows] = useState<UnitRow[]>(() => [newRow()]);
  const [formError, setFormError] = useState('');

  // Shared batch location — same two-stage location→shelf pattern as ItemQuickAdd.
  // Optional: leaving it unset keeps current_location_id null, same as before.
  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null);
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(null);

  // DB-backed search over UNIT-TRACKED items (in-SQL, not a capped pre-load +
  // post-filter) — faithfully restores the old unit_tracked===1 filter. NB:
  // kind='equipment' is NOT equivalent (an equipment item can have unit_tracked=0,
  // and attaching units to it would create stock-invisible phantom inventory).
  const itemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12, 0, undefined, undefined, true).map(i => ({
        id: i.id,
        label: i.name,
        sublabel: i.tag_prefix ?? undefined,
      })),
    [],
  );

  const allLocations = useMemo(() => getAllLocations(), []);
  const locationById = useMemo(() => new Map(allLocations.map(l => [l.id, l])), [allLocations]);
  const locationOptions = useMemo<PickerOption[]>(
    () => allLocations.map(l => {
      const parentName = l.parent_id ? locationById.get(l.parent_id)?.name : undefined;
      return { id: l.id, label: l.name, sublabel: parentName };
    }),
    [allLocations, locationById],
  );

  // The selected location's has_shelves flag drives the Shelf field.
  const selectedLocFull = selectedLocation ? locationById.get(selectedLocation.id) : undefined;
  const locationHasShelves = selectedLocFull?.has_shelves === 1;
  const shelfOptions = useMemo<PickerOption[]>(
    () => (locationHasShelves && selectedLocation)
      ? getShelvesForParent(selectedLocation.id).map(s => ({ id: s.id, label: s.name }))
      : [],
    [locationHasShelves, selectedLocation],
  );

  // Selecting a location resets the shelf (shelf is per-location); tap again to clear.
  function handleLocationSelect(opt: PickerOption) {
    setShelfValue(null);
    setSelectedLocation(prev => (prev?.id === opt.id ? null : opt));
  }

  function updateRow(key: string, patch: Partial<UnitRow>) {
    setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    // Seed the new batch row with the current item's tag prefix so the user only
    // has to type the number (tags are placed physically — no auto-numbering).
    setRows(prev => [...prev, newRow(selectedItem?.sublabel ?? '')]);
  }

  function removeRow(key: string) {
    setRows(prev => (prev.length <= 1 ? prev : prev.filter(r => r.key !== key)));
  }

  function handleSave() {
    if (!selectedItem) {
      setFormError('Select an item first.');
      return;
    }

    // Validate every row up front — clean/bound each (possibly scanned) tag,
    // reject blanks, and check for dups both within the batch and against what's
    // already in the DB. Stop at the first bad row and point at it; commit nothing
    // until every row is clean.
    const seenTags = new Set<string>();
    const cleaned: { key: string; tag: string; serial: string | null }[] = [];
    let badKey: string | null = null;

    for (const row of rows) {
      const rawTag = row.assetTag.trim();
      if (!rawTag) {
        badKey = row.key;
        updateRow(row.key, { error: 'Asset tag is required.' });
        break;
      }
      const tag = sanitizeScan(rawTag);
      if (!tag) {
        badKey = row.key;
        updateRow(row.key, { error: 'Asset tag is too long or contains invalid characters.' });
        break;
      }
      const tagKey = tag.toLowerCase();
      if (seenTags.has(tagKey)) {
        badKey = row.key;
        updateRow(row.key, { error: 'Duplicate tag in this batch.' });
        break;
      }
      if (getUnitByTag(tag) !== null) {
        badKey = row.key;
        updateRow(row.key, { error: 'Tag already used.' });
        break;
      }
      seenTags.add(tagKey);
      cleaned.push({ key: row.key, tag, serial: row.serial.trim() || null });
    }

    if (badKey) {
      // Clear stale errors on every other row so only the offending one is flagged.
      setRows(prev => prev.map(r => (r.key === badKey ? r : { ...r, error: '' })));
      setFormError('');
      return;
    }

    // Resolve the shared batch location the same way ItemQuickAdd resolves its
    // home location: shelf (creating it if new) wins over the bare location.
    let resolvedLocationId: string | null = null;
    if (selectedLocation) {
      if (locationHasShelves && shelfValue?.label) {
        if (shelfValue.id === '__new__') {
          let resolved: string | null = null;
          try {
            resolved = findOrCreateShelf(selectedLocation.id, shelfValue.label);
          } catch {
            resolved = null;
          }
          if (!resolved) {
            setFormError(`We couldn’t create the shelf “${shelfValue.label}”. Pick an existing shelf or try again.`);
            return;
          }
          resolvedLocationId = resolved;
        } else {
          resolvedLocationId = shelfValue.id;
        }
      } else {
        resolvedLocationId = selectedLocation.id;
      }
    }

    setFormError('');
    setRows(prev => prev.map(r => ({ ...r, error: '' })));

    const now = new Date().toISOString();
    const createdIds: string[] = [];

    // Atomic write: every unit's upsert + outbox + log all-or-nothing, so a
    // mid-batch failure can't leave some units saved and others missing.
    try {
      runInTransaction(() => {
        for (const row of cleaned) {
          const id = generateUUID();
          const u: EquipmentUnit = {
            id,
            item_id: selectedItem.id,
            asset_tag: row.tag,
            serial_number: row.serial,
            status: 'available',
            current_location_id: resolvedLocationId,
            current_job_id: null,
            notes: null,
            purchase_price: null,
            acquired_at: null,
            useful_life_months: null,
            salvage_value: null,
            depreciation_method: null,
            next_service_at: null,
            service_interval_months: null,
            created_at: now,
            updated_at: now,
            synced_at: null,
          };
          upsertUnit(u);
          // synced_at is local-only — strip from the outbox payload (server has no such column).
          const { synced_at: _s, ...unitRow } = u;
          appendOutbox('INSERT', 'equipment_units', { ...unitRow });
          appendLog({
            action: 'add_units',
            entity_type: 'equipment_unit',
            entity_id: id,
            user_id: user?.id ?? null,
            team_id: null,
            note: row.tag,
            from_location_id: null,
            to_location_id: null,
            quantity: null,
            unit: null,
            job_id: null,
            metadata: null,
            device_id: null,
          });
          createdIds.push(id);
        }
      });
    } catch {
      Alert.alert(
        cleaned.length > 1 ? 'Couldn’t save units' : 'Couldn’t save unit',
        'Something went wrong saving these units, so nothing was changed. Please try again.',
      );
      return;
    }

    // Writes succeeded — only now clear the batch and signal success. When more
    // than one unit was saved, the edit affordance targets just the last one
    // (the one most likely to still be "fresh" in mind for a quick fix) rather
    // than trying to represent a whole batch.
    const label = cleaned.length === 1
      ? cleaned[0].tag
      : `${cleaned.length} units (${cleaned.map(r => r.tag).join(', ')})`;
    onSaved(label, createdIds[createdIds.length - 1], { kind: 'equipment_unit' });
    // Fresh single row; item + location stay sticky, so re-seed the tag prefix too.
    setRows([newRow(selectedItem?.sublabel ?? '')]);
  }

  return (
    <View style={s.container}>
      <FieldLabel>Item (unit-tracked)</FieldLabel>
      <SearchablePicker
        placeholder="Search tracked items..."
        searchFn={itemSearch}
        value={selectedItem}
        onSelect={opt => {
          const toggledOff = selectedItem?.id === opt.id;
          setSelectedItem(toggledOff ? null : opt);
          // Tags are placed physically — we don't auto-number. On selecting a NEW
          // item, seed its prefix into every still-empty row so the user just types
          // the number; never clobber a row they've already typed into. On toggle
          // off, strip any row still holding just the bare prefix.
          const prevPrefix = selectedItem?.sublabel ?? '';
          if (toggledOff) {
            setRows(prev => prev.map(r =>
              (prevPrefix && r.assetTag === prevPrefix) ? { ...r, assetTag: '' } : r,
            ));
          } else {
            const prefix = opt.sublabel ?? '';
            if (prefix) {
              setRows(prev => prev.map(r =>
                r.assetTag === '' ? { ...r, assetTag: prefix } : r,
              ));
            }
          }
          if (formError) setFormError('');
        }}
      />

      {rows.map((row, idx) => (
        <View key={row.key} style={s.rowBlock}>
          {rows.length > 1 && <Text style={s.rowIndex}>Unit {idx + 1}</Text>}
          <View style={s.rowHeader}>
            <View style={s.rowHeaderInput}>
              <BarcodeInput
                label={idx === 0 ? 'Asset tag' : undefined}
                value={row.assetTag}
                onChange={t => updateRow(row.key, { assetTag: t, error: '' })}
                placeholder="AM-0001"
              />
            </View>
            {rows.length > 1 && (
              <TouchableOpacity
                style={s.removeBtn}
                onPress={() => removeRow(row.key)}
                accessibilityLabel={`Remove unit ${idx + 1}`}
              >
                <Text style={s.removeBtnText}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
          {!!row.error && <Text style={s.errorText}>{row.error}</Text>}

          {/* Serial is a child of the asset tag above — indented to read as nested. */}
          <View style={s.serialChild}>
            <AppInput
              placeholder="Serial number (optional)"
              value={row.serial}
              onChangeText={t => updateRow(row.key, { serial: t })}
            />
          </View>
        </View>
      ))}

      <TouchableOpacity style={s.addAnotherBtn} onPress={addRow}>
        <Text style={s.addAnotherText}>+ Add another</Text>
      </TouchableOpacity>

      <FieldLabel>Location for this batch (optional)</FieldLabel>
      <SearchablePicker
        placeholder="Search locations…"
        options={locationOptions}
        value={selectedLocation}
        onSelect={handleLocationSelect}
      />
      {locationHasShelves && (
        <>
          <FieldLabel>Shelf</FieldLabel>
          <SearchablePicker
            placeholder="Type or pick a shelf (e.g. A1)…"
            options={shelfOptions}
            value={shelfValue}
            onSelect={(opt) => setShelfValue(prev => (prev?.id === opt.id ? null : opt))}
            onCreate={(text) => setShelfValue({ id: '__new__', label: text })}
          />
        </>
      )}

      {!!formError && <Text style={s.errorText}>{formError}</Text>}

      <PrimaryButton
        label={rows.length > 1 ? `Save ${rows.length} units` : 'Save & add another'}
        onPress={handleSave}
        disabled={!selectedItem || locked}
        style={{ marginTop: spacing.md }}
      />
      {locked && <MaintenanceBanner />}
      <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: 10 },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
  rowBlock: {
    gap: 6,
    borderLeftWidth: 2,
    borderLeftColor: colors.borderDetail,
    paddingLeft: spacing.sm,
  },
  rowIndex: {
    fontSize: fontSizes.xs,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  rowHeaderInput: { flex: 1 },
  removeBtn: {
    height: 44,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  removeBtnText: { color: colors.textSecondary, fontSize: fontSizes.body, fontWeight: '700' },
  // The serial input is the asset tag's child: indented to read as nested under it.
  serialChild: { marginLeft: spacing.md },
  addAnotherBtn: { alignSelf: 'flex-start', paddingVertical: spacing.xs },
  addAnotherText: { color: colors.primaryText, fontSize: fontSizes.body2, fontWeight: '700' },
});
