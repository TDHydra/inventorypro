import { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { generateUUID } from '../utils/uuid';
import { upsertItem, getItemBySku, getItemByBarcode } from '../db/queries/items';
import type { InventoryItem } from '../db/queries/items';
import { appendOutbox } from '../sync/outbox';
import { appendLog } from '../db/queries/log';
import { useSession } from '../hooks/useSession';
import { useMaintenanceMode } from '../hooks/useMaintenanceMode';
import { getItemTypes, parseItemTypeMeta, getProductClasses } from '../db/queries/taxonomy';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../constants/units';
import { runInTransaction } from '../db/tx';
import { parseOptionalCount, parsePackSize } from '../lib/validation';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { PrimaryButton } from './ui/PrimaryButton';
import { FieldLabel } from './ui/FieldLabel';
import { MaintenanceBanner } from './ui/MaintenanceBanner';
import { PermissionGate } from './PermissionGate';

interface Props {
  // Fired once, after a batch import completes, with a human label (e.g. "12
  // items") — matches the QuickAddScreenShell onSaved(label) contract so this
  // slots into the same toast + per-session counter as the other quick-add forms.
  onImported: (label: string) => void;
}

// Header aliases → canonical `inventory_items` field. Keys are pre-normalized
// (lowercased, non-alphanumerics collapsed to single spaces) so "Item #",
// "item#", and "Item Number" all resolve the same way.
const HEADER_ALIASES: Record<string, string> = {
  name: 'name', 'item name': 'name', 'product name': 'name',
  sku: 'sku', 'item sku': 'sku', 'item number': 'sku', 'itemnumber': 'sku',
  item: 'sku', part: 'sku', 'part number': 'sku', 'partnumber': 'sku',
  barcode: 'barcode', 'bar code': 'barcode', upc: 'barcode',
  description: 'description', desc: 'description',
  supplier: 'supplier', vendor: 'supplier',
  model: 'model', 'model number': 'model', 'model number ': 'model',
  category: 'category', 'item type': 'category', type: 'category',
  unit: 'unit', units: 'unit',
  'unit category': 'unit_category', unitcategory: 'unit_category',
  class: 'unit_category', 'product class': 'unit_category',
  'min qty alert': 'min_qty_alert', 'min qty': 'min_qty_alert',
  'minimum qty': 'min_qty_alert', 'min quantity': 'min_qty_alert',
  'low stock': 'min_qty_alert', minimum: 'min_qty_alert',
  'reorder to': 'reorder_to', reorderto: 'reorder_to',
  'reorder qty': 'reorder_to', 'reorder quantity': 'reorder_to', reorder: 'reorder_to',
  'pack size': 'pack_size', packsize: 'pack_size', pack: 'pack_size',
};

// Legacy hardcoded unit-category names (pre product_class-taxonomy), for pasted
// data that says "piece"/"liquid"/etc. instead of an admin-configured class label.
const LEGACY_CLASS_LABELS: Record<string, keyof typeof PRODUCT_CLASS_IDS> = {
  liquid: 'liquid', piece: 'piece', length: 'length', weight: 'weight',
};

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Simple, robust CSV/TSV tokenizer: handles quoted fields (with embedded
// delimiters, commas, and escaped "" quotes), CRLF/LF line endings, and a
// delimiter chosen by the caller. Works on the whole pasted blob (not
// line-by-line) so a quoted field can safely contain a newline.
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    // A quote only opens a quoted field at the START of a field (RFC4180). A bare
    // quote mid-field (e.g. a 1/2" dimension in a value) is a literal character,
    // not a quote-open — otherwise it swallows the rest of the row/paste.
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // Flush a trailing field/row that wasn't terminated by a final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-blank rows (blank pasted lines).
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Picks comma vs tab by whichever is more common on the first line — covers
// both Excel/Sheets copy-paste (tab) and a saved .csv (comma).
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

interface ParsedRow {
  rowNum: number; // 1-based, within the pasted data rows (excludes header)
  name: string;
  sku: string | null;
  barcode: string | null;
  description: string | null;
  supplier: string | null;
  model: string | null;
  category: string | null;
  unit: string;
  unitCategory: string; // resolved product_class id
  minQtyAlert: number;
  reorderTo: number | null;
  packSize: number | null;
  errors: string[];
  warnings: string[];
  valid: boolean;
}

export default function CsvImport({ onImported }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const [rawText, setRawText] = useState('');
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [importing, setImporting] = useState(false);

  // Admin taxonomy read once per mount — a paste-and-preview flow doesn't need
  // this to be live-reactive mid-session.
  const itemTypes = useMemo(() => getItemTypes(), []);
  const productClasses = useMemo(() => getProductClasses({ includeInactive: true }), []);

  function resolveClassId(label: string): string | null {
    const norm = normalize(label);
    const cls = productClasses.find(c => normalize(c.label) === norm);
    if (cls) return cls.id;
    const legacy = LEGACY_CLASS_LABELS[norm];
    return legacy ? PRODUCT_CLASS_IDS[legacy] : null;
  }

  function buildRows(dataRows: string[][], headerMap: (string | undefined)[]): ParsedRow[] {
    const seenSku = new Map<string, number>();
    const seenBarcode = new Map<string, number>();

    return dataRows.map((cells, idx) => {
      const rowNum = idx + 1;
      const rec: Record<string, string> = {};
      headerMap.forEach((key, colIdx) => {
        if (!key) return;
        const v = (cells[colIdx] ?? '').trim();
        if (v) rec[key] = v;
      });

      const errors: string[] = [];
      const warnings: string[] = [];
      const name = (rec.name ?? '').trim();
      if (!name) errors.push('Name is required.');

      const skuRaw = rec.sku?.trim() || '';
      if (skuRaw) {
        const key = skuRaw.toLowerCase();
        const existing = getItemBySku(skuRaw);
        if (existing) errors.push(`SKU already in catalog ("${existing.name}").`);
        else if (seenSku.has(key)) errors.push(`Duplicate SKU (also row ${seenSku.get(key)}).`);
        else seenSku.set(key, rowNum);
      }

      const barcodeRaw = rec.barcode?.trim() || '';
      if (barcodeRaw) {
        const key = barcodeRaw.toLowerCase();
        const existingB = getItemByBarcode(barcodeRaw);
        if (existingB) errors.push(`Barcode already in catalog ("${existingB.name}").`);
        else if (seenBarcode.has(key)) errors.push(`Duplicate barcode (also row ${seenBarcode.get(key)}).`);
        else seenBarcode.set(key, rowNum);
      }

      let minQtyAlert = 0;
      if (rec.min_qty_alert) {
        const r = parseOptionalCount(rec.min_qty_alert, 'Min qty alert');
        if (!r.ok) errors.push(r.error); else minQtyAlert = r.value ?? 0;
      }

      let reorderTo: number | null = null;
      if (rec.reorder_to) {
        const r = parseOptionalCount(rec.reorder_to, 'Reorder to');
        if (!r.ok) errors.push(r.error); else reorderTo = r.value;
      }

      let packSize: number | null = null;
      if (rec.pack_size) {
        const r = parsePackSize(rec.pack_size);
        if (!r.ok) errors.push(r.error); else packSize = r.value;
      }

      // Category → item_category taxonomy label (drives default unit class +
      // curated units), same rule ItemQuickAdd uses for its type chips.
      const categoryRaw = rec.category?.trim() || '';
      const matchedType = categoryRaw
        ? itemTypes.find(t => normalize(t.label) === normalize(categoryRaw))
        : undefined;
      if (categoryRaw && !matchedType) {
        warnings.push(`Item type "${categoryRaw}" not found — saved as text only.`);
      }

      let classId: string | null = matchedType ? parseItemTypeMeta(matchedType.meta).classId : null;
      if (!classId && rec.unit_category) {
        classId = resolveClassId(rec.unit_category);
        if (!classId) warnings.push(`Unit category "${rec.unit_category}" not recognized — defaulted to Piece.`);
      }
      if (!classId) classId = PRODUCT_CLASS_IDS.piece;

      const typeUnits = matchedType ? parseItemTypeMeta(matchedType.meta).units : [];
      const unitOptions = typeUnits.length > 0 ? typeUnits : getUnitsForClass(classId);
      const unit = rec.unit?.trim() || unitOptions[0] || 'each';

      return {
        rowNum,
        name,
        sku: skuRaw || null,
        barcode: barcodeRaw || null,
        description: rec.description?.trim() || null,
        supplier: rec.supplier?.trim() || null,
        model: rec.model?.trim() || null,
        category: categoryRaw || null,
        unit,
        unitCategory: classId,
        minQtyAlert,
        reorderTo,
        packSize,
        errors,
        warnings,
        valid: errors.length === 0,
      };
    });
  }

  function handlePreview() {
    setHeaderError(null);
    setRows(null);
    const text = rawText;
    if (!text.trim()) return;

    const delimiter = detectDelimiter(text);
    const table = parseDelimited(text, delimiter);
    if (table.length === 0) {
      setHeaderError('Nothing to import — paste a header row plus at least one data row.');
      return;
    }

    const headerCells = table[0];
    const headerMap = headerCells.map(h => HEADER_ALIASES[normalize(h)]);
    if (!headerMap.includes('name')) {
      setHeaderError('No "name" column found in the header row (first pasted line).');
      return;
    }

    const dataRows = table.slice(1);
    if (dataRows.length === 0) {
      setHeaderError('Header row found, but no data rows follow it.');
      return;
    }

    setRows(buildRows(dataRows, headerMap));
  }

  function handleEditAgain() {
    setRows(null);
    setHeaderError(null);
  }

  function handleImport() {
    if (!rows) return;
    const validRows = rows.filter(r => r.valid);
    const skipped = rows.length - validRows.length;
    if (validRows.length === 0) {
      Alert.alert('Nothing to import', 'Every row has at least one error — fix the pasted data and try again.');
      return;
    }

    setImporting(true);
    try {
      runInTransaction(() => {
        for (const row of validRows) {
          const id = generateUUID();
          const now = new Date().toISOString();
          const item: InventoryItem = {
            id,
            name: row.name,
            barcode: row.barcode,
            description: row.description,
            sku: row.sku,
            supplier: row.supplier,
            model: row.model,
            kind: 'product',
            category: row.category,
            returnable: 0,
            unit_tracked: 0,
            tag_prefix: null,
            unit_category: row.unitCategory,
            unit: row.unit,
            min_qty_alert: row.minQtyAlert,
            reorder_to: row.reorderTo,
            active: 1,
            updated_at: now,
            synced_at: null,
            home_location_id: null,
            pack_size: row.packSize,
          };
          upsertItem(item);
          // synced_at is a local-only column — strip it from the outbox payload.
          const { synced_at: _s, ...itemRow } = item;
          appendOutbox('INSERT', 'inventory_items', {
            ...itemRow,
            returnable: !!item.returnable,
            unit_tracked: !!item.unit_tracked,
            active: true,
          });
          appendLog({
            action: 'item_created',
            entity_type: 'item',
            entity_id: id,
            user_id: user?.id ?? null,
            team_id: null,
            from_location_id: null,
            to_location_id: null,
            quantity: null,
            unit: null,
            job_id: null,
            note: row.name,
            metadata: null,
            device_id: null,
          });
        }
      });
    } catch {
      setImporting(false);
      Alert.alert(
        'Import failed',
        'Something went wrong importing these items, so nothing was changed. Please try again.',
      );
      return;
    }

    setImporting(false);
    const imported = validRows.length;
    Alert.alert(
      'Import complete',
      `${imported} item${imported === 1 ? '' : 's'} imported.${skipped > 0 ? ` ${skipped} row${skipped === 1 ? '' : 's'} skipped (see errors above).` : ''}`,
    );
    onImported(`${imported} item${imported === 1 ? '' : 's'}`);
    setRawText('');
    setRows(null);
    setHeaderError(null);
  }

  const validCount = rows ? rows.filter(r => r.valid).length : 0;
  const invalidCount = rows ? rows.length - validCount : 0;

  return (
    <View style={s.container}>
      {!rows && (
        <>
          <FieldLabel>Paste CSV or TSV (first row = headers)</FieldLabel>
          <Text style={s.hint}>
            Supported columns: name* · sku · barcode · description · supplier · model · category
            (item type) · unit · unit_category · min_qty_alert · reorder_to · pack_size
          </Text>
          <TextInput
            style={s.textarea}
            value={rawText}
            onChangeText={setRawText}
            placeholder={'name,sku,barcode,category,unit,min_qty_alert\nWork Gloves,WG-100,012345,PPE,pair,5'}
            placeholderTextColor={t.colors.textMuted}
            multiline
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!headerError && <Text style={s.errorText}>{headerError}</Text>}
          <PrimaryButton
            label="Preview import"
            onPress={handlePreview}
            disabled={!rawText.trim() || locked}
            style={{ marginTop: t.spacing.md }}
          />
          {locked && <MaintenanceBanner />}
        </>
      )}

      {rows && (
        <>
          <View style={s.summaryRow}>
            <Text style={s.summaryText}>
              {validCount} ready to import{invalidCount > 0 ? `, ${invalidCount} skipped (errors)` : ''} — {rows.length} row{rows.length === 1 ? '' : 's'} total
            </Text>
          </View>

          {rows.map(row => (
            <View key={row.rowNum} style={[s.rowCard, row.valid ? s.rowCardOk : s.rowCardBad]}>
              <View style={s.rowHeader}>
                <Text style={s.rowNum}>#{row.rowNum}</Text>
                <Text style={s.rowStatus}>{row.valid ? '✓ Ready' : '✗ Skipped'}</Text>
              </View>
              <Text style={s.rowName} numberOfLines={1}>{row.name || '(no name)'}</Text>
              <Text style={s.rowSub} numberOfLines={1}>
                {[row.sku && `#${row.sku}`, row.barcode && `barcode ${row.barcode}`, row.category, `${row.unit}`]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
              {row.errors.map((e, i) => (
                <Text key={i} style={s.rowError}>⚠ {e}</Text>
              ))}
              {row.warnings.map((w, i) => (
                <Text key={i} style={s.rowWarning}>ℹ {w}</Text>
              ))}
            </View>
          ))}

          <View style={s.actionsRow}>
            <TouchableOpacity style={s.editBtn} onPress={handleEditAgain} disabled={importing}>
              <Text style={s.editBtnText}>Back to edit</Text>
            </TouchableOpacity>
            {/* server requires add_inventory (via add/edit_inventory) for the item
                inserts this triggers — gate it so a denied user learns why (#76). */}
            <PermissionGate permission="add_inventory" mode="disable">
              <PrimaryButton
                label={importing ? 'Importing…' : `Import ${validCount} item${validCount === 1 ? '' : 's'}`}
                onPress={handleImport}
                disabled={validCount === 0 || locked}
                loading={importing}
                style={{ flex: 1 }}
              />
            </PermissionGate>
          </View>
          {locked && <MaintenanceBanner />}
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { gap: 10 },
  hint: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: -4, marginBottom: 2 },
  textarea: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm, minHeight: 160, fontSize: t.typography.fontSizes.body2,
    color: t.colors.textPrimary, fontFamily: t.typography.fontFamily.mono,
  },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  summaryRow: { paddingVertical: 4 },
  summaryText: { fontSize: t.typography.fontSizes.body2, fontWeight: '700', color: t.colors.textSecondary },
  rowCard: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderLeftWidth: 4,
    padding: t.spacing.sm, gap: 2,
  },
  rowCardOk: { borderColor: t.colors.border, borderLeftColor: t.colors.success },
  rowCardBad: { borderColor: t.colors.border, borderLeftColor: t.colors.danger },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  rowNum: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, fontWeight: '700' },
  rowStatus: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, fontWeight: '700' },
  rowName: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  rowSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
  rowError: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger },
  rowWarning: { fontSize: t.typography.fontSizes.caption, color: t.colors.accent },
  actionsRow: { flexDirection: 'row', gap: t.spacing.sm, alignItems: 'center', marginTop: t.spacing.md },
  editBtn: { paddingVertical: 13, paddingHorizontal: t.spacing.lg, borderRadius: t.radii.lg, borderWidth: 1, borderColor: t.colors.border },
  editBtnText: { color: t.colors.textSecondary, fontWeight: '700', fontSize: t.typography.fontSizes.base },
});
