import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { getAllActiveUsers, User } from '../../db/queries/users';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { Field } from '../ui/Field';

// The getAllActiveUsers() → PickerOption[] wiring the user fields hand-roll,
// extracted once. The active set is small, so it preloads like LocationPicker
// rather than querying per-keystroke. Selection is held by the caller as a
// PickerOption; re-tapping the selection clears it.
export function UserPicker({
  value,
  onChange,
  label,
  placeholder,
  filter,
  disabled,
}: {
  value: PickerOption | null;
  onChange: (opt: PickerOption | null) => void;
  label?: string;
  placeholder?: string;
  filter?: (u: User) => boolean;
  disabled?: boolean;
}) {
  const options = useMemo<PickerOption[]>(() => {
    const users = filter ? getAllActiveUsers().filter(filter) : getAllActiveUsers();
    return users.map(u => ({ id: u.id, label: u.name }));
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
