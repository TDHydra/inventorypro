import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { confirmDestructive } from '../../lib/confirm';
import { useSession } from '../../hooks/useSession';
import { runInTransaction } from '../../db/tx';
import { getDb } from '../../db/schema';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { getItemById, updateItemFields, adjustStock, upsertStock } from '../../db/queries/items';
import { getUnitById, upsertUnit, setUnitStatus } from '../../db/queries/equipmentUnits';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { colors, spacing, fontSizes } from '../../theme';
import { track } from '../../telemetry';
import { parseStockQuantity, validateName, validateText } from '../../lib/validation';
import type { JustAddedRef } from './justAdded';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add_edit', props: { field, rule } });
}

interface Props {
  visible: boolean;
  entityRef: JustAddedRef | null;
  /** Mirrors the full screens' `edit_inventory` gate — hides Save for item/unit/
   * stock fields when the user can't edit inventory. */
  canEdit: boolean;
  /** Deactivating an item is the stricter `delete_inventory` permission (some
   * roles have edit_inventory without it) — units/stock have no such split, they
   * stay behind `canEdit` (see QuickAddScreenShell.canManage). */
  canDeleteItems: boolean;
  /** Stock adjust/undo requires checkin OR checkout (the server's ADJUST gate),
   * NOT edit_inventory — the shell resolves this and passes it here. */
  canAdjustStock: boolean;
  onClose: () => void;
  /** `patch` lets the sheet hand back updated ref fields (stock's `qty`) so the
   * shell's recent-list entry stays correct if it's edited again. */
  onSaved: (label: string, patch?: Partial<JustAddedRef>) => void;
  onDeleted: () => void;
}

/**
 * Lightweight edit/delete sheet for an entity just created via Quick Add — fixes
 * a mistake (typo, wrong qty, wrong tag) without leaving the quick-add flow.
 * Reuses the exact same mutation + outbox + log calls as the full editor screens
 * ((inventory)/[id] for items, (equipment)/[id] for units, the "add stock" path
 * for stock) so quick-add corrections sync the same way. Deliberately covers only
 * the handful of fields most likely to need a quick fix — not a full editor.
 */
export function QuickAddEditSheet({ visible, entityRef, canEdit, canDeleteItems, canAdjustStock, onClose, onSaved, onDeleted }: Props) {
  const { user } = useSession();
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [serial, setSerial] = useState('');
  const [qty, setQty] = useState('');
  const [error, setError] = useState('');

  // Seed the form from the current row whenever a new entity is opened for editing.
  useEffect(() => {
    setError('');
    if (!entityRef) return;
    if (entityRef.kind === 'item') {
      const it = getItemById(entityRef.id);
      setName(it?.name ?? '');
      setSku(it?.sku ?? '');
      setCategory(it?.category ?? '');
    } else if (entityRef.kind === 'equipment_unit') {
      const u = getUnitById(entityRef.id);
      setTag(u?.asset_tag ?? '');
      setSerial(u?.serial_number ?? '');
    } else if (entityRef.kind === 'stock') {
      setQty(String(entityRef.qty));
    }
  }, [entityRef]);

  if (!entityRef) return null;

  // ── Item: name/sku/category edit, active=0 delete (mirrors (inventory)/[id].tsx
  // edits + the (locations)/[id].tsx archive pattern — items have no dedicated
  // delete screen, so we reuse the same raw active=0 + outbox + log shape). ──────
  function saveItem(ref: Extract<JustAddedRef, { kind: 'item' }>) {
    if (!canEdit) return;
    // Bounded, control-char-free fields (same 'Name is required.' copy as
    // before for the blank case) — validated before any local write.
    const nameResult = validateName(name);
    if (!nameResult.ok) { trackReject('item.name', nameResult.rule); setError(nameResult.error); return; }
    const trimmed = nameResult.value;
    const skuResult = validateText(sku, { label: 'Item # / SKU', max: 100 });
    if (!skuResult.ok) { trackReject('item.sku', skuResult.rule); setError(skuResult.error); return; }
    const catResult = validateText(category, { label: 'Category', max: 200 });
    if (!catResult.ok) { trackReject('item.category', catResult.rule); setError(catResult.error); return; }
    setError('');
    try {
      runInTransaction(() => {
        const synced = updateItemFields(ref.id, {
          name: trimmed,
          sku: skuResult.value || null,
          category: catResult.value || null,
        });
        appendOutbox('UPDATE', 'inventory_items', synced);
        appendLog({
          action: 'item_updated', entity_type: 'item', entity_id: ref.id,
          user_id: user?.id ?? null, team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, note: `quick edit: ${trimmed}`, metadata: null, device_id: null,
        });
      });
    } catch {
      Alert.alert('Couldn’t save', 'Something went wrong, so nothing was changed. Please try again.');
      return;
    }
    onSaved(trimmed);
  }

  function deleteItem(ref: Extract<JustAddedRef, { kind: 'item' }>) {
    if (!canDeleteItems) return;
    confirmDestructive({
      title: 'Remove item?',
      message: `Deactivate "${name || 'this item'}"? It will be hidden from active lists.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        const now = new Date().toISOString();
        try {
          runInTransaction(() => {
            getDb().executeSync(`UPDATE inventory_items SET active=0, updated_at=? WHERE id=?`, [now, ref.id]);
            appendOutbox('UPDATE', 'inventory_items', { id: ref.id, active: false, updated_at: now });
            appendLog({
              action: 'delete_inventory', entity_type: 'item', entity_id: ref.id,
              user_id: user?.id ?? null, team_id: null, from_location_id: null, to_location_id: null,
              quantity: null, unit: null, job_id: null, note: name || null, metadata: null, device_id: null,
            });
          });
        } catch {
          Alert.alert('Couldn’t remove', 'Something went wrong, so nothing was changed. Please try again.');
          return;
        }
        onDeleted();
      },
    });
  }

  // ── Equipment unit: asset_tag/serial edit, retire delete (mirrors saveEditUnit /
  // doRetireUnit in (equipment)/[id].tsx exactly). ────────────────────────────────
  function saveUnit(ref: Extract<JustAddedRef, { kind: 'equipment_unit' }>) {
    if (!canEdit) return;
    // Same 'Asset tag is required.' copy as before for the blank case.
    const tagResult = validateName(tag, { label: 'Asset tag' });
    if (!tagResult.ok) { trackReject('equipment_unit.asset_tag', tagResult.rule); setError(tagResult.error); return; }
    const trimmedTag = tagResult.value;
    const serialResult = validateText(serial, { label: 'Serial number', max: 200 });
    if (!serialResult.ok) { trackReject('equipment_unit.serial_number', serialResult.rule); setError(serialResult.error); return; }
    const cur = getUnitById(ref.id);
    if (!cur) { setError('Unit not found.'); return; }
    setError('');
    const now = new Date().toISOString();
    const changes = { asset_tag: trimmedTag, serial_number: serialResult.value || null };
    try {
      runInTransaction(() => {
        upsertUnit({ ...cur, ...changes, updated_at: now });
        appendOutbox('UPDATE', 'equipment_units', { id: ref.id, ...changes, updated_at: now });
        appendLog({
          user_id: user?.id ?? null, team_id: null, action: 'unit_edited',
          entity_type: 'equipment_unit', entity_id: ref.id,
          from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
          note: 'edited ' + trimmedTag, metadata: null, device_id: null,
        });
      });
    } catch {
      Alert.alert('Couldn’t save', 'Something went wrong, so nothing was changed. Please try again.');
      return;
    }
    onSaved(trimmedTag);
  }

  function deleteUnit(ref: Extract<JustAddedRef, { kind: 'equipment_unit' }>) {
    if (!canEdit) return;
    confirmDestructive({
      title: 'Retire unit?',
      message: `Retire ${tag || 'this unit'}? This cannot be undone.`,
      confirmLabel: 'Retire',
      onConfirm: () => {
        try {
          runInTransaction(() => {
            const updated = setUnitStatus(ref.id, { status: 'retired' });
            appendOutbox('UPDATE', 'equipment_units', { id: ref.id, status: 'retired', updated_at: updated.updated_at });
            appendLog({
              user_id: user?.id ?? null, team_id: null, action: 'unit_retired',
              entity_type: 'equipment_unit', entity_id: ref.id,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: 'retired ' + (tag || ref.id), metadata: null, device_id: null,
            });
          });
        } catch {
          Alert.alert('Couldn’t retire', 'Something went wrong, so nothing was changed. Please try again.');
          return;
        }
        onDeleted();
      },
    });
  }

  // ── Stock: qty edit (mirrors StockQuickAdd's own delta/set handling), undo
  // (reverses the add via adjustStock — same signed-delta pattern MoveStockModal /
  // checkout use). A "set" (recount) has no prior value to restore, so undo is
  // only offered for "delta" adds. ────────────────────────────────────────────────
  function saveStock(ref: Extract<JustAddedRef, { kind: 'stock' }>) {
    if (!canAdjustStock) return;
    // parseStockQuantity keeps the historical parseFloat + copy ('delta' > 0,
    // 'set' recount may be 0), adding the overflow bound.
    const qtyResult = parseStockQuantity(qty, ref.mode);
    if (!qtyResult.ok) {
      trackReject('stock.qty', qtyResult.rule);
      setError(qtyResult.error);
      return;
    }
    const parsed = qtyResult.value;
    setError('');
    const now = new Date().toISOString();
    try {
      runInTransaction(() => {
        if (ref.mode === 'set') {
          upsertStock({ item_id: ref.itemId, location_id: ref.locationId, quantity: parsed, updated_at: now });
          appendOutbox('INSERT', 'stock_by_location', {
            item_id: ref.itemId, location_id: ref.locationId, quantity: parsed, updated_at: now,
          });
          appendLog({
            action: 'recount', entity_type: 'item', entity_id: ref.itemId, to_location_id: ref.locationId,
            quantity: parsed, unit: ref.unit, user_id: user?.id ?? null, team_id: null, from_location_id: null,
            job_id: null, note: 'quick edit', metadata: null, device_id: null,
          });
        } else {
          const delta = parsed - ref.qty;
          if (delta !== 0) {
            adjustStock(ref.itemId, ref.locationId, delta);
            appendOutbox('ADJUST', 'stock_by_location', {
              item_id: ref.itemId, location_id: ref.locationId, delta, updated_at: now,
            });
            appendLog({
              action: 'adjust_stock', entity_type: 'item', entity_id: ref.itemId, to_location_id: ref.locationId,
              quantity: delta, unit: ref.unit, user_id: user?.id ?? null, team_id: null, from_location_id: null,
              job_id: null, note: 'quick edit correction', metadata: null, device_id: null,
            });
          }
        }
      });
    } catch {
      Alert.alert('Couldn’t save', 'Something went wrong, so nothing was changed. Please try again.');
      return;
    }
    onSaved(`${parsed} ${ref.unit}`, { qty: parsed });
  }

  function deleteStock(ref: Extract<JustAddedRef, { kind: 'stock' }>) {
    if (!canAdjustStock) return;
    confirmDestructive({
      title: 'Undo this stock add?',
      message: `Remove the ${ref.qty} ${ref.unit} just added? This reverses the addition.`,
      confirmLabel: 'Undo',
      onConfirm: () => {
        const now = new Date().toISOString();
        try {
          runInTransaction(() => {
            adjustStock(ref.itemId, ref.locationId, -ref.qty);
            appendOutbox('ADJUST', 'stock_by_location', {
              item_id: ref.itemId, location_id: ref.locationId, delta: -ref.qty, updated_at: now,
            });
            appendLog({
              action: 'adjust_stock', entity_type: 'item', entity_id: ref.itemId, to_location_id: ref.locationId,
              quantity: -ref.qty, unit: ref.unit, user_id: user?.id ?? null, team_id: null, from_location_id: null,
              job_id: null, note: 'undo quick add', metadata: null, device_id: null,
            });
          });
        } catch {
          Alert.alert('Couldn’t undo', 'Something went wrong, so nothing was changed. Please try again.');
          return;
        }
        onDeleted();
      },
    });
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      {entityRef.kind === 'item' && (
        <View style={s.body}>
          <Text style={s.title}>Edit item</Text>
          <FieldLabel>Name</FieldLabel>
          <AppInput value={name} onChangeText={setName} placeholder="Item name" autoFocus editable={canEdit} />
          <FieldLabel>Item # / SKU</FieldLabel>
          <AppInput value={sku} onChangeText={setSku} placeholder="Item # / Part #" autoCapitalize="characters" editable={canEdit} />
          <FieldLabel>Category</FieldLabel>
          <AppInput value={category} onChangeText={setCategory} placeholder="Category" editable={canEdit} />
          {!!error && <Text style={s.error}>{error}</Text>}
          {canEdit && (
            <PrimaryButton label="Save" onPress={() => saveItem(entityRef)} style={{ marginTop: spacing.md }} />
          )}
          {canDeleteItems && (
            <PrimaryButton label="Remove item" tone="danger" onPress={() => deleteItem(entityRef)} style={{ marginTop: spacing.sm }} />
          )}
        </View>
      )}
      {entityRef.kind === 'equipment_unit' && (
        <View style={s.body}>
          <Text style={s.title}>Edit unit</Text>
          <FieldLabel>Asset tag</FieldLabel>
          <AppInput value={tag} onChangeText={setTag} placeholder="Asset tag" autoCapitalize="characters" autoFocus editable={canEdit} />
          <FieldLabel>Serial number</FieldLabel>
          <AppInput value={serial} onChangeText={setSerial} placeholder="Serial number (optional)" editable={canEdit} />
          {!!error && <Text style={s.error}>{error}</Text>}
          {canEdit && (
            <>
              <PrimaryButton label="Save" onPress={() => saveUnit(entityRef)} style={{ marginTop: spacing.md }} />
              <PrimaryButton label="Retire unit" tone="danger" onPress={() => deleteUnit(entityRef)} style={{ marginTop: spacing.sm }} />
            </>
          )}
        </View>
      )}
      {entityRef.kind === 'stock' && (
        <View style={s.body}>
          <Text style={s.title}>Edit stock</Text>
          <FieldLabel>{entityRef.mode === 'set' ? 'New quantity' : 'Quantity added'}</FieldLabel>
          <AppInput value={qty} onChangeText={setQty} placeholder="Quantity" keyboardType="decimal-pad" autoFocus editable={canAdjustStock} />
          {!!error && <Text style={s.error}>{error}</Text>}
          {canAdjustStock && (
            <>
              <PrimaryButton label="Save" onPress={() => saveStock(entityRef)} style={{ marginTop: spacing.md }} />
              {entityRef.mode === 'delta' && (
                <PrimaryButton label="Undo this add" tone="danger" onPress={() => deleteStock(entityRef)} style={{ marginTop: spacing.sm }} />
              )}
            </>
          )}
        </View>
      )}
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  body: { gap: 10 },
  title: { fontSize: fontSizes.md, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  error: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
});
