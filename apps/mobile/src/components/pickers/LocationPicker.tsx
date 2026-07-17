import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { getNonShelfLocations, Location } from '../../db/queries/locations';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { Field } from '../ui/Field';

// The locations → PickerOption[] wiring the location fields hand-roll (see
// (jobs)/create.tsx's locationOptions useMemo), extracted once. Options come from
// getNonShelfLocations() — shelves are never first-class options here; they're
// only reachable via LocationShelfPicker's Shelf sub-field. Selection is held
// by the caller as a PickerOption; re-tapping the selection clears it, matching
// today's `onSelect={opt => setX(prev => prev?.id === opt.id ? null : opt)}`.
export function LocationPicker({
  value,
  onChange,
  label,
  placeholder,
  filter,
  allowCreate,
  disabled,
}: {
  value: PickerOption | null;
  onChange: (opt: PickerOption | null) => void;
  label?: string;
  placeholder?: string;
  filter?: (l: Location) => boolean;
  allowCreate?: boolean;
  disabled?: boolean;
}) {
  const options = useMemo<PickerOption[]>(() => {
    const all = getNonShelfLocations();
    const byId = new Map(all.map(l => [l.id, l]));
    const locs = filter ? all.filter(filter) : all;
    // Parent shown as sublabel (same wiring as ItemQuickAdd's locationOptions).
    return locs.map(l => {
      const parentName = l.parent_id ? byId.get(l.parent_id)?.name : undefined;
      return { id: l.id, label: l.name, sublabel: parentName };
    });
    // `filter` is expected stable (defined inline is fine — options only recompute
    // on mount today, matching the screens' `[]`-dep useMemo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const picker = (
    <SearchablePicker
      placeholder={placeholder}
      options={options}
      value={value}
      onSelect={opt => onChange(value && opt.id === value.id ? null : opt)}
      // A typed-in location isn't a row yet: report it as a synthetic option; the
      // call site decides whether to create it.
      onCreate={allowCreate ? (text => onChange({ id: '__new__', label: text })) : undefined}
    />
  );

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
