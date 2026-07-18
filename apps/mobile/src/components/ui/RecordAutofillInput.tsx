import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { AppInput } from './AppInput';
import { Field } from './Field';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { filterRecordOptions, type RecordOption } from './recordAutofillFilter';

/**
 * "Pick a previous entry → autofill EVERY field."
 *
 * Generalizes the hand-rolled `offerCrossFill` pattern from
 * `app/(app)/(jobs)/create.tsx` (pick a known customer → offer to fill
 * carrier/address from their last job) into a reusable field: a labeled
 * text input with a filter-as-you-type dropdown of full records (not just
 * strings, unlike `SuggestInput`/`AutofillTextField`). Tapping a suggestion
 * fills the text value immediately, then asks once via the app's themed
 * confirm — accepting hands the caller the FULL record so it can fill every
 * other field; declining (or just typing) leaves everything else alone.
 *
 * Usage:
 * ```tsx
 * <RecordAutofillInput
 *   label="Customer"
 *   value={customerName}
 *   onChangeText={setCustomerName}
 *   options={customers.map(c => ({ label: c.name, sublabel: c.lastJobAt, record: c }))}
 *   onAutofill={(c) => {
 *     setSiteAddress(c.site_address ?? '');
 *     setInsuranceCarrier(c.insurance_carrier ?? '');
 *   }}
 * />
 * ```
 */

// Pure filter logic lives in ./recordAutofillFilter (no react/react-native
// imports) so it's unit-testable under node:test without pulling in RN's
// Flow-syntax internals via the tsx loader — mirrors QuantityStepper/quantityMath.
export type { RecordOption } from './recordAutofillFilter';
export { filterRecordOptions } from './recordAutofillFilter';

interface Props<T> {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  /** Full records to offer (caller reads these from a src/db/queries/* fn). */
  options: RecordOption<T>[];
  /** Caller sets all its other form state from the picked record. */
  onAutofill: (record: T) => void;
  confirmTitle?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  maxSuggestions?: number;
}

export function RecordAutofillInput<T>({
  label,
  value,
  onChangeText,
  options,
  onAutofill,
  confirmTitle = 'Fill the other fields from this entry?',
  placeholder,
  required,
  hint,
  error,
  maxSuggestions = 8,
}: Props<T>) {
  const s = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  const matches = useMemo(
    () => filterRecordOptions(options, value, maxSuggestions),
    [options, value, maxSuggestions],
  );

  const open = focused && matches.length > 0;

  function pick(option: RecordOption<T>) {
    onChangeText(option.label);
    setFocused(false);
    // Filling in the other fields is a benign, reversible action (not data
    // loss), so this uses a plain two-button themed Alert — cancel + a
    // default-styled confirm — rather than `confirmDestructive`'s red danger
    // button. Mirrors `offerCrossFill` in app/(app)/(jobs)/create.tsx.
    Alert.alert(
      confirmTitle,
      option.sublabel ? `${option.label} — ${option.sublabel}` : option.label,
      [
        { text: 'Skip', style: 'cancel' },
        { text: 'Fill in', onPress: () => onAutofill(option.record) },
      ],
    );
  }

  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <View style={s.wrap}>
        <AppInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          // Delay so a row tap registers before the list hides.
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {open && (
          <ScrollView style={s.dropdown} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
            {matches.map((option, i) => (
              <TouchableOpacity key={`${option.label}-${i}`} style={s.row} onPress={() => pick(option)}>
                <Text style={s.rowLabel}>{option.label}</Text>
                {!!option.sublabel && <Text style={s.rowSublabel}>{option.sublabel}</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </Field>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { position: 'relative' },
  dropdown: { maxHeight: 240, backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border, marginTop: 2 },
  row: { paddingHorizontal: t.spacing.base, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  rowSublabel: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
});
