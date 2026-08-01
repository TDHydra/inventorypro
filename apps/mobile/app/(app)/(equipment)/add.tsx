import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { upsertItem } from '../../../src/db/queries/items';
import { upsertUnit, getUnitByTag } from '../../../src/db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../../src/db/queries/equipmentUnits';
import { PRODUCT_CLASS_IDS } from '../../../src/constants/units';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useSession } from '../../../src/hooks/useSession';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { TaxonomyChips } from '../../../src/components/pickers';
import { HidableField } from '../../../src/components/ui/HidableField';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { TextField } from '../../../src/components/ui/TextField';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// Cap the equipment name so a runaway paste can't bloat the catalog row.
const MAX_NAME_LENGTH = 200;

interface PendingUnit {
  id: string;
  assetTag: string;
  serial: string;
}

export default function AddEquipmentScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Generate the model UUID up front so MediaGallery can upload photos to this
  // entity immediately, before the item row is committed to the DB.
  const [modelId] = useState(() => generateUUID());

  const [name, setName] = useState('');
  // Equipment type (taxonomy category 'equipment', #28): label cache + durable id.
  const [type, setType] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [tagPrefix, setTagPrefix] = useState('');

  // Per-unit inline form
  const [assetTag, setAssetTag] = useState('');
  const [serial, setSerial] = useState('');
  const [tagError, setTagError] = useState('');

  const [pendingUnits, setPendingUnits] = useState<PendingUnit[]>([]);

  function handleAddUnit() {
    const tag = assetTag.trim();
    if (!tag) {
      setTagError('Asset tag is required.');
      return;
    }
    // Reject tags already registered in the DB
    let existing: EquipmentUnit | null;
    try {
      existing = getUnitByTag(tag);
    } catch (e) {
      Alert.alert('Error', 'Could not verify tag uniqueness. Try again.');
      return;
    }
    if (existing !== null) {
      setTagError('Tag already in use.');
      return;
    }
    // Reject tags already queued in this form session
    if (pendingUnits.some(u => u.assetTag === tag)) {
      setTagError('Tag already added.');
      return;
    }
    setTagError('');
    setPendingUnits(prev => [
      ...prev,
      { id: generateUUID(), assetTag: tag, serial: serial.trim() },
    ]);
    setAssetTag('');
    setSerial('');
  }

  function removeUnit(id: string) {
    setPendingUnits(prev => prev.filter(u => u.id !== id));
  }

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Required', 'Equipment name is required.');
      return;
    }
    if (trimmedName.length > MAX_NAME_LENGTH) {
      Alert.alert(
        'Name too long',
        `Equipment name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      );
      return;
    }
    // Preserve the write-guard: appendOutbox calls assertWritable internally,
    // but we check here first so we can return cleanly before any DB writes.
    if (isWriteBlocked()) {
      Alert.alert(
        'Read-only mode',
        'The app is in maintenance mode right now, so equipment cannot be saved. Try again shortly.',
      );
      return;
    }

    const now = new Date().toISOString();
    const prefix = tagPrefix.trim() || null;

    // ── Create the equipment model (catalog row in inventory_items) ──────────
    const payload = {
      id: modelId,
      name: trimmedName,
      barcode: null as string | null,
      description: null as string | null,
      sku: null as string | null,
      supplier: null as string | null,
      model: null as string | null,
      kind: 'equipment' as const,
      category: null as string | null,
      type,
      type_id: typeId,
      // Stored as integer in SQLite; outbox sends as boolean for Postgres
      returnable: 1 as number,
      // Stable Pieces class id (not the legacy 'piece' enum — 012 only remaps existing rows).
      unit_category: PRODUCT_CLASS_IDS.piece,
      unit: 'each',
      min_qty_alert: 0,
      reorder_to: null as number | null,
    };

    // Persist the model and every queued unit atomically: if any write fails
    // mid-loop the whole flow rolls back, so we never leave an orphaned model
    // or half-saved units. Only on success do we show confirmation + navigate.
    try {
      runInTransaction(() => {
        upsertItem({
          ...payload,
          unit_tracked: 1,
          tag_prefix: prefix,
          active: 1,
          updated_at: now,
          synced_at: null,
        });

        // Outbox: real booleans for Postgres BOOLEAN columns; synced_at stripped
        appendOutbox('INSERT', 'inventory_items', {
          ...payload,
          active: true,
          updated_at: now,
          returnable: true,
          unit_tracked: true,
          tag_prefix: prefix,
        });

        // ── Persist each queued unit ──────────────────────────────────────────────
        for (const pu of pendingUnits) {
          const u: EquipmentUnit = {
            id: pu.id,
            item_id: modelId,
            asset_tag: pu.assetTag,
            serial_number: pu.serial || null,
            status: 'available',
            current_location_id: null,
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
          // synced_at is local-only — server has no such column; strip from outbox payload
          const { synced_at: _s, ...unitRow } = u;
          appendOutbox('INSERT', 'equipment_units', { ...unitRow });
          appendLog({
            action: 'add_units',
            entity_type: 'equipment_unit',
            entity_id: pu.id,
            user_id: realUser?.id ?? null,
            team_id: null,
            note: pu.assetTag,
            from_location_id: null,
            to_location_id: null,
            quantity: null,
            unit: null,
            job_id: null,
            metadata: null,
            device_id: null,
          });
        }
      });
    } catch (e) {
      Alert.alert(
        'Save failed',
        'Could not save this equipment model. No changes were made — please try again.',
      );
      return;
    }

    const unitCount = pendingUnits.length;
    Alert.alert(
      'Equipment saved',
      unitCount > 0
        ? `"${trimmedName}" was created with ${unitCount} unit${unitCount !== 1 ? 's' : ''}.`
        : `"${trimmedName}" was created.`,
      [{ text: 'OK', onPress: () => router.back() }],
    );
  }

  const prefixTrimmed = tagPrefix.trim();

  return (
    <>
      <Stack.Screen options={{ title: 'Add Equipment', headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>

          {/* ── Model photo ───────────────────────────────────────────────── */}
          <FieldLabel>Model Photo</FieldLabel>
          <MediaGallery entityType="item" entityId={modelId} canUpload />

          {/* ── Model name ────────────────────────────────────────────────── */}
          <TextField
            label="Name"
            required
            placeholder="e.g. Air Mover, Dehumidifier 70pt"
            value={name}
            onChangeText={setName}
            autoFocus
          />

          {/* ── Equipment type ────────────────────────────────────────────── */}
          {/* TaxonomyChips returns a fragment; the ScrollView content gap lays
              out the label + chip row like the other bare field pairs here. */}
          <HidableField fieldId="equipment.type">
            <TaxonomyChips
              category="equipment"
              label="Type"
              withFallback
              deselectable
              valueId={typeId}
              valueLabel={type}
              onChange={v => { setType(v.label); setTypeId(v.id); }}
            />
          </HidableField>

          {/* ── Tag prefix ────────────────────────────────────────────────── */}
          <HidableField fieldId="equipment.tag_prefix">
            <TextField
              label="Asset Tag Prefix (optional)"
              placeholder="e.g. AM-, DH-, MSC-"
              value={tagPrefix}
              onChangeText={setTagPrefix}
              autoCapitalize="characters"
            />
          </HidableField>

          {/* ── Initial units ─────────────────────────────────────────────── */}
          <View style={s.sectionDivider}>
            <Text style={s.sectionTitle}>Initial Units (optional)</Text>
          </View>

          <BarcodeInput
            label="Asset tag"
            value={assetTag}
            onChange={t => {
              setAssetTag(t);
              if (tagError) setTagError('');
            }}
            placeholder={prefixTrimmed ? `${prefixTrimmed}001` : 'AM-001'}
          />

          {!!tagError && <Text style={s.errorText}>{tagError}</Text>}

          <HidableField fieldId="equipment.serial_number">
            <TextField
              label="Serial number (optional)"
              placeholder="e.g. SN-12345"
              value={serial}
              onChangeText={setSerial}
            />
          </HidableField>

          <TouchableOpacity style={s.addUnitBtn} onPress={handleAddUnit}>
            <Text style={s.addUnitText}>+ Add Unit</Text>
          </TouchableOpacity>

          {pendingUnits.length > 0 && (
            <View style={s.unitList}>
              {pendingUnits.map((u, idx) => (
                <View
                  key={u.id}
                  style={[
                    s.unitRow,
                    idx === pendingUnits.length - 1 && s.unitRowLast,
                  ]}
                >
                  <View style={s.unitInfo}>
                    <Text style={s.unitTag}>{u.assetTag}</Text>
                    {!!u.serial && (
                      <Text style={s.unitSerial}>S/N: {u.serial}</Text>
                    )}
                  </View>
                  <TouchableOpacity
                    onPress={() => removeUnit(u.id)}
                    style={s.removeBtn}
                    accessibilityLabel={`Remove unit ${u.assetTag}`}
                  >
                    <Text style={s.removeText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* ── Actions ──────────────────────────────────────────────────── */}
          <PrimaryButton
            label={
              pendingUnits.length > 0
                ? `Save Model + ${pendingUnits.length} Unit${pendingUnits.length !== 1 ? 's' : ''}`
                : 'Save Equipment Model'
            }
            onPress={handleSave}
            disabled={locked}
            style={{ marginTop: t.spacing.xl }}
          />
          {locked && <MaintenanceBanner />}

          <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>

      </FormScreen>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: t.spacing.lg, gap: t.spacing.sm, paddingBottom: 48 },
  sectionDivider: {
    marginTop: t.spacing.md,
    paddingTop: t.spacing.md,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
  },
  sectionTitle: {
    fontSize: t.typography.fontSizes.body,
    fontWeight: '700',
    color: t.colors.textSecondary,
  },
  errorText: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.danger,
    marginTop: -4,
  },
  addUnitBtn: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.primaryBgStrong,
    paddingVertical: t.spacing.sm,
    alignItems: 'center',
  },
  addUnitText: {
    color: t.colors.primaryText,
    fontWeight: '700',
    fontSize: t.typography.fontSizes.body,
  },
  unitList: {
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    overflow: 'hidden',
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: t.colors.border,
  },
  unitRowLast: { borderBottomWidth: 0 },
  unitInfo: { gap: 2 },
  unitTag: {
    fontSize: t.typography.fontSizes.body,
    fontWeight: '700',
    color: t.colors.textPrimary,
  },
  unitSerial: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary },
  removeBtn: { padding: t.spacing.xs },
  removeText: { fontSize: t.typography.fontSizes.md, color: t.colors.danger },
  cancelBtn: { alignItems: 'center', paddingVertical: t.spacing.md },
  cancelText: {
    color: t.colors.textMuted,
    fontSize: t.typography.fontSizes.md,
    fontWeight: '600',
  },
});
