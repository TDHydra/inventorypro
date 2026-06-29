import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { searchItems } from '../../db/queries/items';
import { upsertUnit, getUnitByTag } from '../../db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../db/queries/equipmentUnits';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { BarcodeInput } from '../BarcodeInput';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { nextAssetTag } from '../../db/queries/equipment';
import { colors, spacing, fontSizes, radii } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function EquipmentQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null); // sticky
  const [assetTag, setAssetTag] = useState('');
  const [serial, setSerial] = useState('');
  const [tagError, setTagError] = useState('');

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

  function handleSave() {
    const tag = assetTag.trim();
    if (!selectedItem) {
      setTagError('Select an item first.');
      return;
    }
    if (!tag) {
      setTagError('Asset tag is required.');
      return;
    }

    // Reject duplicate tag
    const existing = getUnitByTag(tag);
    if (existing !== null) {
      setTagError('Tag already used.');
      return;
    }
    setTagError('');

    const now = new Date().toISOString();
    const id = generateUUID();

    const u: EquipmentUnit = {
      id,
      item_id: selectedItem.id,
      asset_tag: tag,
      serial_number: serial.trim() || null,
      status: 'available',
      current_location_id: null,
      current_job_id: null,
      notes: null,
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
      note: tag,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      metadata: null,
      device_id: null,
    });

    onSaved(tag, id);
    setAssetTag(''); // clear tag+serial; keep item sticky
    setSerial('');
  }

  return (
    <View style={s.container}>
      <FieldLabel>Item (unit-tracked)</FieldLabel>
      <SearchablePicker
        placeholder="Search tracked items..."
        searchFn={itemSearch}
        value={selectedItem}
        onSelect={opt => {
          setSelectedItem(prev => prev?.id === opt.id ? null : opt);
          if (tagError) setTagError('');
        }}
      />

      <BarcodeInput
        label="Asset tag"
        value={assetTag}
        onChange={t => { setAssetTag(t); if (tagError) setTagError(''); }}
        placeholder="AM-0001"
      />
      {!!selectedItem?.sublabel && assetTag === '' && (
        <TouchableOpacity
          style={s.generateBtn}
          onPress={() => {
            setAssetTag(nextAssetTag(selectedItem.sublabel!));
            if (tagError) setTagError('');
          }}
        >
          <Text style={s.generateBtnText}>Generate</Text>
        </TouchableOpacity>
      )}
      {!!tagError && <Text style={s.errorText}>{tagError}</Text>}

      <AppInput
        placeholder="Serial number (optional)"
        value={serial}
        onChangeText={setSerial}
      />

      <PrimaryButton
        label="Save & add another"
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
  generateBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: -spacing.xs,
  },
  generateBtnText: {
    color: colors.primaryText,
    fontSize: fontSizes.caption,
    fontWeight: '600',
  },
});
