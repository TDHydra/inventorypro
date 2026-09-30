import { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';
import { getStockByItem, type StockByLocation } from '../../repos/items';
import { getAllLocations } from '../../repos/locations';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { LocationSuggestionBanner } from '../LocationSuggestionBanner';
import { useCurrentPosition } from '../../hooks/useCurrentPosition';
import { sortByProximity } from '../../location/proximity';
import { formatQuantity } from '../../constants/units';
import type { UnitCategory } from '../../constants/units';

// A row of stock_by_location with the proximity annotation sortByProximity adds.
export type StockRowWithDistance = StockByLocation & { distanceM: number | null };

interface Props {
  /** Item whose stock locations are offered. Null → nothing to pick yet. */
  itemId: string | null;
  value: StockRowWithDistance | null;
  onChange: (row: StockRowWithDistance | null) => void;
  /** Item unit + unit class, for the "14 each" / "2.5 gal" on-hand sublabels. */
  unit: string;
  unitCategory: UnitCategory;
  /** Shown in place of the picker when the item has stock nowhere. */
  emptyText?: string;
}

/**
 * "Where is this item actually stocked?" picker — the counterpart to
 * LocationShelfPicker, which offers EVERY location in the org whether or not it
 * holds the item.
 *
 * Only locations with a positive stock_by_location row are offered, each row
 * labelled with its on-hand quantity and parent, ordered nearest-first
 * (sortByProximity). The nearest stocked location is auto-selected, so the
 * common single-location case needs no taps at all; when the item sits in more
 * than one place the full list is right there to override, and
 * LocationSuggestionBanner offers a one-tap snap back to the nearest after a
 * manual override.
 *
 * This is the checkout screen's "Source Location" behavior (app/(app)/checkout.tsx
 * — buildUnitSourceStock/sortedSourceStock/sourceOptions) extracted so the
 * repair "Use parts" sheet gets the same semantics rather than a second,
 * subtly-different implementation. Unit-tracked items are NOT special-cased
 * here: they carry no stock_by_location rows, so they correctly present as
 * "stocked nowhere" (a unit-tracked asset is checked out, not consumed as a
 * quantity of parts).
 */
export function StockLocationPicker({
  itemId, value, onChange, unit, unitCategory, emptyText,
}: Props) {
  const s = useThemedStyles(makeStyles);
  // Platform-resolved (expo-location native / navigator.geolocation on web), so
  // no native module reaches the web bundle. Same opt-in shape LocationShelfPicker
  // uses: without a fix, sortByProximity degrades to source order.
  const { coords, request } = useCurrentPosition();
  useEffect(() => { void request(); }, [request]);

  // Reactive: a sync pull (or a local adjustment made elsewhere) that changes
  // this item's stock re-reads the options while the sheet is open.
  const stock = useDbQuery(
    () => (itemId ? getStockByItem(itemId).filter(r => r.quantity > 0) : []),
    [itemId],
    ['stock_by_location', 'locations'],
  );
  const locById = useDbQuery(
    () => new Map(getAllLocations().map(l => [l.id, l])),
    [],
    ['locations'],
  );

  // Enrich with the parent location's coordinates so an un-anchored shelf still
  // sorts by where it physically is (a shelf inherits its building's position).
  const rows = useMemo<StockRowWithDistance[]>(() => {
    const enriched = stock.map(r => {
      const self = locById.get(r.location_id);
      const parent = r.parent_id ? locById.get(r.parent_id) : undefined;
      return {
        ...r,
        latitude: self?.latitude ?? parent?.latitude ?? null,
        longitude: self?.longitude ?? parent?.longitude ?? null,
      };
    });
    // Drop the lat/lng we only added for sorting — callers want a stock row.
    return sortByProximity(enriched, coords).map(({ latitude, longitude, ...r }) => r);
  }, [stock, locById, coords]);

  // Auto-select. Fires when nothing is selected yet (item just picked) or when
  // the selection stopped being a stocked location (its stock was consumed by a
  // sync pull). A MANUAL override leaves `value` present and still in `rows`, so
  // coords arriving later never clobber the user's choice.
  useEffect(() => {
    if (rows.length === 0) {
      if (value) onChange(null);
      return;
    }
    if (value && rows.some(r => r.location_id === value.location_id)) return;
    onChange(rows[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange is a setter; re-running on its identity would loop
  }, [rows, value?.location_id]);

  const nearest = useMemo(
    () => rows.find(r => r.distanceM != null) ?? null,
    [rows],
  );

  const options = useMemo<PickerOption[]>(
    () => rows.map(r => ({
      id: r.location_id,
      label: r.location_name,
      sublabel: [
        r.parent_name,
        formatQuantity(r.quantity, unit, unitCategory),
        r.distanceM != null ? `~${Math.round(r.distanceM)} m` : undefined,
      ].filter(Boolean).join(' · '),
    })),
    [rows, unit, unitCategory],
  );

  if (!itemId) return null;
  if (rows.length === 0) {
    return <Text style={s.empty}>{emptyText ?? 'This item has no stock recorded anywhere.'}</Text>;
  }

  const selectedOption = value
    ? options.find(o => o.id === value.location_id) ?? null
    : null;

  return (
    <View style={s.wrap}>
      {/* Only worth saying when there's actually a choice to make. */}
      {rows.length > 1 && (
        <Text style={s.multi}>
          {`In ${rows.length} locations — tap Change to pick a different one.`}
        </Text>
      )}
      <LocationSuggestionBanner
        name={nearest && value?.location_id !== nearest.location_id ? nearest.location_name : null}
        distanceM={nearest?.distanceM ?? null}
        onUse={() => nearest && onChange(nearest)}
      />
      <SearchablePicker
        placeholder="Search stocked locations…"
        options={options}
        value={selectedOption}
        onSelect={opt => {
          const row = rows.find(r => r.location_id === opt.id) ?? null;
          // No clear-on-retap: a part must come OUT of somewhere, so deselecting
          // the only stocked location would just dead-end the sheet.
          if (row) onChange(row);
        }}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { gap: t.spacing.sm },
  multi: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary },
  empty: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, paddingVertical: 6 },
});
