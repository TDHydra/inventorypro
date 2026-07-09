import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, fontSizes } from '../../theme';
import { FieldLabel } from './FieldLabel';

// The <View style={s.fieldWrap}><FieldLabel>…</FieldLabel>{children}</View> wrapper
// that every form field on every screen hand-rolls, extracted once. `fieldWrap`'s
// gap:6 is copied verbatim from the screens (e.g. (jobs)/create.tsx) so a swap is
// visually identical. `required` appends the " *" the screens spell out in the
// label string. hint/error are additive slots the raw wrapper never had.
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={s.fieldWrap}>
      <FieldLabel>{required ? `${label} *` : label}</FieldLabel>
      {!!hint && <Text style={s.hint}>{hint}</Text>}
      {children}
      {!!error && <Text style={s.error}>{error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  fieldWrap: { gap: 6 },
  hint: { fontSize: fontSizes.caption, color: colors.textMuted },
  error: { fontSize: fontSizes.caption, color: colors.danger },
});
