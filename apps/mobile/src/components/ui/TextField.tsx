import { TextInputProps, StyleSheet } from 'react-native';
import { Field } from './Field';
import { AppInput } from './AppInput';

interface Props extends Omit<TextInputProps, 'value' | 'onChangeText' | 'style'> {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
}

/**
 * Field + AppInput in one line — drop-in for the identical file-local `Field`
 * components in (inventory)/[id].tsx and (equipment)/[id].tsx (their
 * keyboardType/autoCapitalize/autoFocus props flow through the TextInputProps
 * spread; only `onChange` → `onChangeText` renames). The multiline style is
 * copied verbatim from those dupes.
 */
export function TextField({ label, value, onChangeText, multiline, required, hint, error, ...rest }: Props) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <AppInput
        style={multiline ? s.multiline : undefined}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
        {...rest}
      />
    </Field>
  );
}

const s = StyleSheet.create({
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
});
