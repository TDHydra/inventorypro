import { View, StyleSheet } from 'react-native';
import { searchItems } from '../../db/queries/items';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { Field } from '../ui/Field';

const itemSearchFn = (q: string): PickerOption[] =>
  searchItems(q).map(i => ({ id: i.id, label: i.name }));

// The item-catalog dropdown the checkout/stock screens hand-roll, extracted once.
// The catalog has >1000 rows, so this MUST go through SearchablePicker's searchFn
// (query-per-keystroke, DB-backed) — a preloaded/capped `options` array would hide
// most rows. Selection is held by the caller as a PickerOption; re-tapping the
// selection clears it.
export function ItemPicker({
  value,
  onChange,
  label,
  placeholder,
  allowCreate,
  disabled,
}: {
  value: PickerOption | null;
  onChange: (opt: PickerOption | null) => void;
  label?: string;
  placeholder?: string;
  allowCreate?: boolean;
  disabled?: boolean;
}) {
  const picker = (
    <SearchablePicker
      placeholder={placeholder}
      searchFn={itemSearchFn}
      value={value}
      onSelect={opt => onChange(value && opt.id === value.id ? null : opt)}
      // A typed-in item isn't a row yet: report it as a synthetic option; the
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
