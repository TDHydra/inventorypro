import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import {
  getTaxonomyTypes,
  getTaxonomyTypesWithFallback,
} from '../../db/queries/taxonomy';
import { renderIcon } from '../../constants/locationStyles';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { resolveTaxonomyValue } from './resolveTaxonomyValue';

// Sibling of TaxonomyPicker for the OTHER taxonomy shape: the horizontal row of
// FilterChips (getTaxonomyTypes* + map → `${renderIcon(icon)} ${label}` chip +
// hold selection) that teams/index, teams/[id], JobQuickAdd and TeamQuickAdd each
// hand-roll. TaxonomyPicker's SearchablePicker dropdown cannot express this row.
//
// #74 is mid-migration: some screens persist the taxonomy LABEL, some the soft-FK
// id. Like TaxonomyPicker this ALWAYS reports both via onChange and never migrates
// which one a call site persists.
//
// Returns a FRAGMENT, not a Field/View wrapper: at every call site the FieldLabel
// and the chip ScrollView are laid out by the PARENT container's gap (12 in the
// team modals, s.fieldWrap in the quickadds). Wrapping them would change that
// spacing, so they stay bare siblings the parent positions.
// There is deliberately no `defaultToFirst` prop. Seeding the first type from a
// mount effect paints one frame with nothing selected, and ModalSheet's <Modal>
// unmounts its children while hidden, so every open would flash. Call sites seed
// synchronously in their own useState initializer instead.
export function TaxonomyChips({
  category,
  valueId,
  valueLabel,
  onChange,
  label,
  withFallback,
  deselectable,
  disabled,
}: {
  category: string;
  valueId?: string | null;
  valueLabel?: string | null;
  onChange: (next: { id: string | null; label: string | null }) => void;
  label?: string;
  withFallback?: boolean;      // getTaxonomyTypesWithFallback (teams) vs getTaxonomyTypes (quickadds)
  deselectable?: boolean;      // JobQuickAdd's re-tap-clears; the other three never clear
  disabled?: boolean;
}) {
  // Options exactly as each screen sources them — strict active list, or the
  // never-empty fallback list. Both spellings appear across the four call sites.
  const types = useMemo(
    () =>
      withFallback
        ? getTaxonomyTypesWithFallback(category)
        : getTaxonomyTypes(category),
    [category, withFallback],
  );

  // Resolve the stored value (id and/or label) against the SAME list that renders
  // the chips, so an id- and a label-persisting screen (#74) light up the identical
  // chip; an archived/unknown value resolves to nothing and lights none — matching
  // today's `value === t.label` when the value isn't in the list.
  const resolved = resolveTaxonomyValue(types, valueId, valueLabel);
  function isActive(t: { id: string; label: string }): boolean {
    return resolved.id != null ? resolved.id === t.id : resolved.label === t.label;
  }

  function handlePress(t: { id: string; label: string }) {
    if (deselectable && isActive(t)) {
      onChange({ id: null, label: null });
      return;
    }
    onChange({ id: t.id, label: t.label });
  }

  return (
    <>
      {!!label && <FieldLabel>{label}</FieldLabel>}
      {/* No call site disables this today; pointerEvents+opacity is additive only. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.chipRow}
        pointerEvents={disabled ? 'none' : 'auto'}
        style={disabled ? s.disabled : undefined}
      >
        {types.map(t => (
          <FilterChip
            key={t.label}
            label={`${renderIcon(t.icon)} ${t.label}`}
            active={isActive(t)}
            onPress={() => handlePress(t)}
          />
        ))}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  chipRow: { gap: 8, paddingRight: 8 },
  disabled: { opacity: 0.5 },
});
