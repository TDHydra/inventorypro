import type { Ref } from 'react';
import { TextInput, TextInputProps } from 'react-native';
import { Field } from './Field';
import { SuggestInput } from '../SuggestInput';
import { useSuggestions } from '../../hooks/useSuggestions';
import type { SuggestibleTable, SuggestibleColumn } from '../../db/queries/suggestions';

interface Props<T extends SuggestibleTable> {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  table: T;
  column: SuggestibleColumn<T>;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  maxSuggestions?: number;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  onPick?: (v: string) => void;
  autoFocus?: boolean;
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  returnKeyType?: TextInputProps['returnKeyType'];
  /** Reaches the underlying native TextInput (focus/blur). */
  inputRef?: Ref<TextInput>;
}

/**
 * THE universal drop-in form field: a labeled text input that automatically
 * offers live suggestions from previously-entered values in the local DB.
 * `Field` (label/required/hint/error) + `SuggestInput` (filter-as-you-type
 * dropdown) fed by `useSuggestions(table, column)` — one line per field, no
 * per-screen wiring, and no need to hand-roll the label since `Field` already
 * renders it (so `SuggestInput`'s own optional `label` prop is left unset
 * here to avoid a duplicate).
 *
 * Usage:
 * ```tsx
 * <AutofillTextField
 *   label="Supplier"
 *   table="inventory_items"
 *   column="supplier"
 *   value={supplier}
 *   onChangeText={setSupplier}
 * />
 * ```
 */
export function AutofillTextField<T extends SuggestibleTable>({
  label,
  value,
  onChangeText,
  table,
  column,
  placeholder,
  required,
  hint,
  error,
  maxSuggestions,
  autoCapitalize,
  onPick,
  autoFocus,
  onSubmitEditing,
  returnKeyType,
  inputRef,
}: Props<T>) {
  const suggestions = useSuggestions(table, column);

  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <SuggestInput
        value={value}
        onChange={onChangeText}
        placeholder={placeholder}
        suggestions={suggestions}
        // SuggestInput's prop type is narrower ('none' | 'words' | 'characters') than
        // TextInputProps['autoCapitalize'] (which also allows 'sentences'); the
        // underlying TextInput supports the full set at runtime regardless, so this
        // is a type-only narrowing, not a behavior change.
        autoCapitalize={autoCapitalize as 'none' | 'words' | 'characters' | undefined}
        maxSuggestions={maxSuggestions}
        onPick={onPick}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        inputRef={inputRef}
      />
    </Field>
  );
}
