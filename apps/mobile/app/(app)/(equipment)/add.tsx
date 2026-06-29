import { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { upsertItem } from '../../../src/db/queries/items';
import { upsertUnit, getUnitByTag } from '../../../src/db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../../src/db/queries/equipmentUnits';
import { nextAssetTag } from '../../../src/db/queries/equipment';
import { PRODUCT_CLASS_IDS } from '../../../src/constants/units';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useSession } from '../../../src/hooks/useSession';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { AppInput } from '../../../src/components/ui/AppInput';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { colors, spacing, fontSizes, radii } from '../../../src/theme';

interface PendingUnit {
  id: string;
  assetTag: string;
  serial: string;
}

export default function AddEquipmentScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  // Generate the model UUID up front so MediaGallery can upload photos to this
  // entity immediately, before the item row is committed to the DB.
  const [modelId] = useState(() => generateUUID());

  const [name, setName] = useState('');
  const [tagPrefix, setTagPrefix] = useState('');

  // Per-unit inline form
  const [assetTag, setAssetTag] = useState('');
  const [serial, setSerial] = useState('');
  const [tagError, setTagError] = useState('');

  const [pendingUnits, setPendingUnits] = useState<PendingUnit[]>([]);

  // Generate the next asset tag for the given prefix, accounting for units that
  // are already in the pending list but not yet in the DB.
  const handleGenerate = useCallback(() => {
    const prefix = tagPrefix.trim();
    if (!prefix) return;
    let tag = nextAssetTag(prefix);
    // If the DB-suggested tag already appears in pendingUnits, keep bumping.
    const existingTags = new Set(pendingUnits.map(u => u.assetTag));
    while (existingTags.has(tag)) {
      const n = parseInt(tag.slice(prefix.length), 10) + 1;
      tag = prefix + String(n).padStart(3, '0');
    }
    setAssetTag(tag);
    if (tagError) setTagError('');
  }, [tagPrefix, pendingUnits, tagError]);

  function handleAddUnit() {
    const tag = assetTag.trim();
    if (!tag) {
      setTagError('Asset tag is required.');
      return;
    }
    // Reject tags already registered in the DB
    if (getUnitByTag(tag) !== null) {
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
    if (!name.trim()) {
      Alert.alert('Required', 'Equipment name is required.');
      return;
    }
    // Preserve the write-guard: appendOutbox calls assertWritable internally,
    // but we check here first so we can return cleanly before any DB writes.
    if (isWriteBlocked()) return;

    const now = new Date().toISOString();
    const prefix = tagPrefix.trim() || null;

    // ── Create the equipment model (catalog row in inventory_items) ──────────
    const payload = {
      id: modelId,
      name: name.trim(),
      barcode: null as string | null,
      description: null as string | null,
      sku: null as string | null,
      supplier: null as string | null,
      model: null as string | null,
      kind: 'equipment' as const,
      category: null as string | null,
      // Stored as integer in SQLite; outbox sends as boolean for Postgres
      returnable: 1 as number,
      // Stable Pieces class id (not the legacy 'piece' enum — 012 only remaps existing rows).
      unit_category: PRODUCT_CLASS_IDS.piece,
      unit: 'each',
      min_qty_alert: 0,
      reorder_to: null as number | null,
    };

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
        user_id: user?.id ?? null,
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

    router.back();
  }

  const prefixTrimmed = tagPrefix.trim();

  return (
    <>
      <Stack.Screen options={{ title: 'Add Equipment', headerShown: true }} />
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Model photo ───────────────────────────────────────────────── */}
          <FieldLabel>Model Photo</FieldLabel>
          <MediaGallery entityType="item" entityId={modelId} canUpload />

          {/* ── Model name ────────────────────────────────────────────────── */}
          <FieldLabel>Name *</FieldLabel>
          <AppInput
            placeholder="e.g. Air Mover, Dehumidifier 70pt"
            value={name}
            onChangeText={setName}
            autoFocus
          />

          {/* ── Tag prefix ────────────────────────────────────────────────── */}
          <FieldLabel>Asset Tag Prefix (optional)</FieldLabel>
          <AppInput
            placeholder="e.g. AM-, DH-, MSC-"
            value={tagPrefix}
            onChangeText={setTagPrefix}
            autoCapitalize="characters"
          />

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

          {!!prefixTrimmed && assetTag === '' && (
            <TouchableOpacity style={s.generateBtn} onPress={handleGenerate}>
              <Text style={s.generateText}>Generate {prefixTrimmed}</Text>
            </TouchableOpacity>
          )}
          {!!tagError && <Text style={s.errorText}>{tagError}</Text>}

          <AppInput
            placeholder="Serial number (optional)"
            value={serial}
            onChangeText={setSerial}
          />

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
            style={{ marginTop: spacing.xl }}
          />
          {locked && <MaintenanceBanner />}

          <TouchableOpacity style={s.cancelBtn} onPress={() => router.back()}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 48 },
  sectionDivider: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  sectionTitle: {
    fontSize: fontSizes.body,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  generateBtn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primaryBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: -spacing.xs,
  },
  generateText: {
    color: colors.primaryText,
    fontSize: fontSizes.caption,
    fontWeight: '600',
  },
  errorText: {
    fontSize: fontSizes.caption,
    color: colors.danger,
    marginTop: -4,
  },
  addUnitBtn: {
    backgroundColor: colors.primaryBg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.primaryBgStrong,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  addUnitText: {
    color: colors.primaryText,
    fontWeight: '700',
    fontSize: fontSizes.body,
  },
  unitList: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  unitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  unitRowLast: { borderBottomWidth: 0 },
  unitInfo: { gap: 2 },
  unitTag: {
    fontSize: fontSizes.body,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  unitSerial: { fontSize: fontSizes.caption, color: colors.textSecondary },
  removeBtn: { padding: spacing.xs },
  removeText: { fontSize: fontSizes.md, color: colors.danger },
  cancelBtn: { alignItems: 'center', paddingVertical: spacing.md },
  cancelText: {
    color: colors.textMuted,
    fontSize: fontSizes.md,
    fontWeight: '600',
  },
});
