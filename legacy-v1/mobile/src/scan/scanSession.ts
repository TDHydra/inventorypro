import { resolveScan } from './resolveScan';
import { sanitizeScan } from './sanitize';
import { verifyWithConfig } from './qrSignConfig';
import {
  getItemById, getItemByBarcode, findItemByTagPrefix, type InventoryItem,
} from '../db/queries/items';
import { getUnitByTag, type EquipmentUnit } from '../db/queries/equipmentUnits';

export type ScanClass =
  | { kind: 'consumable'; item: InventoryItem }
  | { kind: 'equipment-unit'; unit: EquipmentUnit; item: InventoryItem }
  | { kind: 'equipment-model'; item: InventoryItem }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; code: string };

// Classify a raw scanned string into an actionable category. Resolution order:
//  1. INV:item:/INV:unit: structured codes (resolveScan)
//  2. raw code → existing equipment unit (asset_tag)
//  3. raw code → existing item by barcode
//  4. raw code → equipment model by tag_prefix (new-unit candidate)
//  5. otherwise unknown.
//
// For an un-prefixed raw code (steps 2-4) the lookup PRIORITY is strictly:
//   asset_tag (exact equipment unit) → barcode (exact item) → tag_prefix
//   (equipment model / new-unit candidate). The first match wins, so a value
//   that is both a unit's asset_tag and some item's barcode resolves as the
//   unit. This ordering must not be reshuffled — callers rely on it.
//
// An item is "consumable" when unit_tracked = 0, else equipment.
export function classifyScan(raw: string): ScanClass {
  // Bound & clean attacker-influenceable scanner/QR input at entry. Junk
  // (empty, over-length, or control-char noise) sanitizes to null → treat as
  // unknown rather than feeding it to queries, outbox, or navigation params.
  const cleaned = sanitizeScan(raw);
  if (cleaned == null) return { kind: 'unknown', code: '' };

  // Verify the QR signature (if the code is an INV:/INVS: payload). A tampered
  // signature — or an unsigned INV: when signatures are required — returns null;
  // surface that as 'rejected' rather than silently treating it as a raw code.
  const canonical = verifyWithConfig(cleaned);
  if (canonical === null) return { kind: 'rejected', code: cleaned };

  const parsed = resolveScan(canonical);

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

  const code = parsed?.kind === 'barcode' ? parsed.code : cleaned;

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
