import { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { generateUUID } from '../../utils/uuid';
import { runInTransaction } from '../../db/tx';
import { sanitizeScan } from '../../scan/sanitize';
import { searchItems } from '../../db/queries/items';
import { upsertUnit, getUnitByTag } from '../../db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../db/queries/equipmentUnits';
import { resolveLocationShelfSelection } from '../../db/queries/locations';
import { getUnitInventoryLock } from '../../db/queries/access';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useDbQuery } from '../../hooks/useDbQuery';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { LocationShelfPicker } from '../pickers';
import { BarcodeInput } from '../BarcodeInput';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FormScreen } from '../ui/FormScreen';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateText } from '../../lib/validation';
import type { QuickAddSaveMeta } from './justAdded';

interface Props {
  onSaved: (label: string, createdId?: string, meta?: QuickAddSaveMeta) => void;
}

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
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
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
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
  // The returned function's identity changes whenever inventory_items or
  // equipment_units changes (local write or sync pull, #60/#63), which drives
  // SearchablePicker's own memo (keyed on searchFn identity) to re-run the
  // still-open query against fresh data instead of staying frozen.
  const itemSearch = useDbQuery(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12, 0, undefined, undefined, true).map(i => ({
        id: i.id,
        label: i.name,
        sublabel: i.tag_prefix ?? undefined,
      })),
    [],
    ['inventory_items', 'equipment_units'],
  );

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
    track('action', 'quickadd_save_equipment', { screen: 'quick_add' });
    if (!selectedItem) {
      trackReject('equipment_unit.item', 'required');
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
        trackReject('equipment_unit.asset_tag', 'required');
        updateRow(row.key, { error: 'Asset tag is required.' });
        break;
      }
      const tag = sanitizeScan(rawTag);
      if (!tag) {
        badKey = row.key;
        trackReject('equipment_unit.asset_tag', 'invalid');
        updateRow(row.key, { error: 'Asset tag is too long or contains invalid characters.' });
        break;
      }
      const tagKey = tag.toLowerCase();
      if (seenTags.has(tagKey)) {
        badKey = row.key;
        trackReject('equipment_unit.asset_tag', 'duplicate_batch');
        updateRow(row.key, { error: 'Duplicate tag in this batch.' });
        break;
      }
      if (getUnitByTag(tag) !== null) {
        badKey = row.key;
        trackReject('equipment_unit.asset_tag', 'duplicate');
        updateRow(row.key, { error: 'Tag already used.' });
        break;
      }
      // Serial is optional free text — bound it before it reaches the outbox.
      const serialResult = validateText(row.serial, { label: 'Serial number', max: 200 });
      if (!serialResult.ok) {
        badKey = row.key;
        trackReject('equipment_unit.serial_number', serialResult.rule);
        updateRow(row.key, { error: serialResult.error });
        break;
      }
      seenTags.add(tagKey);
      cleaned.push({ key: row.key, tag, serial: serialResult.value || null });
    }

    if (badKey) {
      // Clear stale errors on every other row so only the offending one is flagged.
      setRows(prev => prev.map(r => (r.key === badKey ? r : { ...r, error: '' })));
      setFormError('');
      return;
    }

    // Resolve the shared batch location the same way ItemQuickAdd resolves its
    // home location: shelf (creating it if new) wins over the bare location.
    // Location is optional here — no selection resolves to a null id.
    const dest = resolveLocationShelfSelection(selectedLocation, shelfValue);
    if (!dest.ok) {
      setFormError(`We couldn’t create the shelf “${dest.shelfLabel}”. Pick an existing shelf or try again.`);
      return;
    }
    const resolvedLocationId = dest.id;

    // #162: no equipment into another team's vehicle/locker without the
    // cross-team perm (defensive — the picker hides units today, but the
    // server rejects the write regardless, so fail here with the reason).
    const teamLock = getUnitInventoryLock(user, resolvedLocationId);
    if (teamLock.locked) {
      setFormError(teamLock.reason ?? 'This unit’s inventory belongs to another team.');
      return;
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
            // #248: new units always start clean with a zeroed cadence counter.
            cleanliness: 'clean',
            jobs_since_clean: 0,
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
            user_id: realUser?.id ?? null,
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
    // The form owns its FormScreen (shell passes wrapForm={false}) so the
    // Save/Done bar can live in the sticky footer slot and float above the
    // keyboard (#118) instead of scrolling away under it.
    <FormScreen
      contentContainerStyle={s.content}
      footer={
        <QuickAddFooter
          saveLabel={rows.length > 1 ? `Save ${rows.length} units` : 'Save & add another'}
          onSave={handleSave}
          disabled={!selectedItem || locked}
          locked={locked}
          error={formError || undefined}
        />
      }
    >
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
      <LocationShelfPicker
        locationValue={selectedLocation}
        shelfValue={shelfValue}
        onChangeLocation={setSelectedLocation}
        onChangeShelf={setShelfValue}
      />
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 10 },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  rowBlock: {
    gap: 6,
    borderLeftWidth: 2,
    borderLeftColor: t.colors.borderDetail,
    paddingLeft: t.spacing.sm,
  },
  rowIndex: {
    fontSize: t.typography.fontSizes.xs,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.sm },
  rowHeaderInput: { flex: 1 },
  removeBtn: {
    height: 44,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: t.radii.sm,
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
  },
  removeBtnText: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  // The serial input is the asset tag's child: indented to read as nested under it.
  serialChild: { marginLeft: t.spacing.md },
  addAnotherBtn: { alignSelf: 'flex-start', paddingVertical: t.spacing.xs },
  addAnotherText: { color: t.colors.primaryText, fontSize: t.typography.fontSizes.body2, fontWeight: '700' },
});
