import { useMemo } from 'react';
import type { Ref } from 'react';
import { TextInput, TextInputProps, StyleProp, TextStyle } from 'react-native';
import { Field, SuggestInput, dedupeLabels, dedupeSegments } from '@invenpro/ui';
import { useSuggestions } from '../../hooks/useSuggestions';
import type { SuggestibleTable, SuggestibleColumn } from '../../repos/suggestions';

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
  /**
   * #289: an authoritative pool to offer AHEAD of the column's own history —
   * e.g. the parts catalog for "Parts needed". Listed first on purpose: where a
   * catalog name and a hand-typed one differ only by case, the catalog spelling
   * wins (see dedupeSegments).
   */
  extraSuggestions?: string[];
  /**
   * #289: also offer `+ Create "X"` under the suggestions, so a value the crew
   * needs can be added to the database from here (see SuggestInput.onCreate).
   * Omit to gate the affordance — callers should pass undefined when the user
   * lacks the permission or the write is locked.
   */
  onCreate?: (text: string) => void;
  /**
   * #289: `list` for a comma-separated multi-value column (parts_needed) — a
   * pick appends instead of replacing, and prior values are split into their
   * segments so the dropdown offers individual parts rather than whole old
   * lists. Callers MUST `normalizeList` before saving. Default `replace`.
   */
  pickMode?: 'replace' | 'list';
  multiline?: boolean;
  /** Passed to the input (e.g. a screen's `multiline` height style). */
  style?: StyleProp<TextStyle>;
  /** #289: false = read-only, suggestions and `+ Create` suppressed with it. */
  editable?: boolean;
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
 *
 * A multi-value column backed by a real catalog (#289) adds three props:
 * ```tsx
 * <AutofillTextField
 *   label="Parts needed" table="repairs" column="parts_needed"
 *   pickMode="list" extraSuggestions={partNames} onCreate={createPart}
 *   value={parts} onChangeText={setParts}
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
  extraSuggestions,
  onCreate,
  pickMode = 'replace',
  multiline,
  style,
  editable,
}: Props<T>) {
  const history = useSuggestions(table, column);

  // In list mode a stored value IS a list, so history contributes its segments;
  // in replace mode a value is one value and must not be shredded on its commas
  // (a note legitimately contains them).
  const suggestions = useMemo(() => {
    const pool = extraSuggestions && extraSuggestions.length > 0
      ? [...extraSuggestions, ...history]
      : history;
    return pickMode === 'list' ? dedupeSegments(pool) : dedupeLabels(pool);
  }, [extraSuggestions, history, pickMode]);

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
        onCreate={onCreate}
        pickMode={pickMode}
        multiline={multiline}
        style={style}
        editable={editable}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        inputRef={inputRef}
      />
    </Field>
  );
}
