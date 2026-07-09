import { useEffect, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import {
  getTaxonomyTypes,
  getTaxonomyTypesWithFallback,
} from '../../db/queries/taxonomy';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { Field } from '../ui/Field';
import { resolveTaxonomyValue, defaultTaxonomyValue } from './resolveTaxonomyValue';

// The taxonomy wiring (getTaxonomyTypes* + useMemo + map-to-PickerOption + hold
// selection + SearchablePicker) that 15 screens hand-roll, extracted once.
//
// #74 is mid-migration: some screens persist the taxonomy LABEL, some the soft-FK
// id. So this ALWAYS reports both via onChange and lets each call site keep
// persisting whatever it persists today — it does NOT migrate label→id.
//
// `category` is passed straight to the query helpers; the real category strings
// (verified against src/db/queries/taxonomy.ts) are: 'job', 'team',
// 'item_category', 'location_type', 'location_subtype', 'repair_status'.
export function TaxonomyPicker({
  category,
  valueId,
  valueLabel,
  onChange,
  label,
  placeholder,
  allowCreate,
  defaultToFirst,
  disabled,
}: {
  category: string;
  valueId?: string | null;
  valueLabel?: string | null;
  onChange: (next: { id: string | null; label: string | null }) => void;
  label?: string;
  placeholder?: string;
  allowCreate?: boolean;
  defaultToFirst?: boolean;
  disabled?: boolean;
}) {
  // Options exactly as the screens source them: fallback list (never empty when
  // rows exist), memoized.
  const types = useMemo(() => getTaxonomyTypesWithFallback(category), [category]);
  const options = useMemo<PickerOption[]>(
    () => types.map(t => ({ id: t.id, label: t.label })),
    [types],
  );

  // Resolve the stored value (id and/or label) against the current list. An
  // archived/unknown value survives so it still displays instead of vanishing.
  const resolved = resolveTaxonomyValue(types, valueId, valueLabel);
  const value: PickerOption | null =
    resolved.id != null || resolved.label != null
      ? { id: resolved.id ?? resolved.label!, label: resolved.label ?? resolved.id! }
      : null;

  // Reproduce today's `getTaxonomyTypes(cat)[0]?.label ?? null` seed: the default
  // comes from the ACTIVE list (no fallback), so a category with only inactive
  // types defaults to nothing — exactly as before. Mount-only, and only when the
  // parent hasn't already supplied a value.
  useEffect(() => {
    if (!defaultToFirst) return;
    if (valueId || valueLabel) return;
    const activeTypes = getTaxonomyTypes(category);
    if (activeTypes.length === 0) return;
    onChange(defaultTaxonomyValue(activeTypes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-tapping the selected option clears it — today's
  // `onSelect={opt => setX(prev => prev?.id === opt.id ? null : opt)}`.
  function handleSelect(opt: PickerOption) {
    if (value && opt.id === value.id) {
      onChange({ id: null, label: null });
      return;
    }
    const t = types.find(x => x.id === opt.id);
    onChange(t ? { id: t.id, label: t.label } : { id: opt.id, label: opt.label });
  }

  const picker = (
    <SearchablePicker
      placeholder={placeholder}
      options={options}
      value={value}
      onSelect={handleSelect}
      // A freshly typed value is not (yet) a taxonomy row: report it as a label
      // with no resolved id. The call site decides whether to persist it / create
      // the row. Always reports both, per the #74 contract.
      onCreate={allowCreate ? (text => onChange({ id: null, label: text })) : undefined}
    />
  );

  // SearchablePicker has no `disabled`; block interaction and dim, without
  // reimplementing it. No call site disables a taxonomy picker today, so this is
  // additive only.
  const body = disabled ? (
    <View pointerEvents="none" style={s.disabled}>{picker}</View>
  ) : (
    picker
  );

  return label ? <Field label={label}>{body}</Field> : body;
}

const s = StyleSheet.create({
  disabled: { opacity: 0.5 },
});
