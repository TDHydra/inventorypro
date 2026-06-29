import { resolveScan } from './resolveScan';
import {
  getItemById, getItemByBarcode, findItemByTagPrefix, type InventoryItem,
} from '../db/queries/items';
import { getUnitByTag, type EquipmentUnit } from '../db/queries/equipmentUnits';

export type ScanClass =
  | { kind: 'consumable'; item: InventoryItem }
  | { kind: 'equipment-unit'; unit: EquipmentUnit; item: InventoryItem }
  | { kind: 'equipment-model'; item: InventoryItem }
  | { kind: 'unknown'; code: string };

// Classify a raw scanned string into an actionable category. Resolution order:
//  1. INV:item:/INV:unit: structured codes (resolveScan)
//  2. raw code → existing equipment unit (asset_tag)
//  3. raw code → existing item by barcode
//  4. raw code → equipment model by tag_prefix (new-unit candidate)
//  5. otherwise unknown.
// An item is "consumable" when unit_tracked = 0, else equipment.
export function classifyScan(raw: string): ScanClass {
  const parsed = resolveScan(raw);

  if (parsed?.kind === 'item') {
    const item = getItemById(parsed.id);
    if (item) return item.unit_tracked
      ? { kind: 'equipment-model', item }
      : { kind: 'consumable', item };
  }
  if (parsed?.kind === 'unit') {
    const u = getUnitByTag(parsed.assetTag);
    if (u) {
      const item = getItemById(u.item_id);
      if (item) return { kind: 'equipment-unit', unit: u, item };
    }
  }

  const code = parsed?.kind === 'barcode' ? parsed.code : raw;

  const u = getUnitByTag(code);
  if (u) {
    const item = getItemById(u.item_id);
    if (item) return { kind: 'equipment-unit', unit: u, item };
  }
  const byBarcode = getItemByBarcode(code);
  if (byBarcode) return byBarcode.unit_tracked
    ? { kind: 'equipment-model', item: byBarcode }
    : { kind: 'consumable', item: byBarcode };
  const byPrefix = findItemByTagPrefix(code);
  if (byPrefix) return { kind: 'equipment-model', item: byPrefix };

  return { kind: 'unknown', code };
}
