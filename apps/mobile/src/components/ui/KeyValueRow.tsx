/**
 * KeyValueRow — standard read-only label/value row for `[id]` detail screens.
 * Replaces hand-rolled label/value pairs duplicated across detail screens.
 *
 * Usage (pairs with `Card`):
 *
 *   <Card variant="detail">
 *     <KeyValueRow label="SKU" value={item.sku} selectable />
 *     <KeyValueRow label="Status" value={item.statusLabel} badge={<StatusBadge label={item.statusLabel} tone="success" />} />
 *     <KeyValueRow label="Notes" value={item.notes} multiline onPress={() => router.push(`/items/${item.id}/notes`)} />
 *   </Card>
 *
 * - Default: row layout, value right-aligned, single line with ellipsis.
 * - `multiline`: column layout, value wraps below the label.
 * - `onPress`: wraps the row in a `Pressable` with a trailing '›' chevron.
 * - `value` of `null`/`undefined`/`''` renders `placeholder` (default '—').
 */
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { ReactNode } from 'react';
import { colors, spacing, fontSizes } from '../../theme';

interface Props {
  label: string;
  value?: string | number | null;
  placeholder?: string;
  onPress?: () => void;
  multiline?: boolean;
  badge?: ReactNode;
  selectable?: boolean;
}

export function KeyValueRow({ label, value, placeholder = '—', onPress, multiline = false, badge, selectable = false }: Props) {
  const isEmpty = value === null || value === undefined || value === '';
  const valueNode = (
    <Text
      style={[
        s.value,
        multiline ? s.valueMultiline : s.valueInline,
        isEmpty && s.placeholder,
      ]}
      numberOfLines={multiline ? undefined : 1}
      ellipsizeMode={multiline ? undefined : 'tail'}
      selectable={selectable && !isEmpty}
    >
      {isEmpty ? placeholder : String(value)}
    </Text>
  );

  const content = (
    <View style={multiline ? s.containerMultiline : s.containerInline}>
      <Text style={s.label}>{label}</Text>
      <View style={multiline ? s.valueWrapMultiline : s.valueWrapInline}>
        {badge ?? valueNode}
        {onPress ? <Text style={s.chevron}>{'›'}</Text> : null}
      </View>
    </View>
  );

  if (!onPress) {
    return <View style={s.row}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.row, pressed && s.rowPressed]}
    >
      {content}
    </Pressable>
  );
}

const s = StyleSheet.create({
  row: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderDetail,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  containerInline: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  containerMultiline: {
    flexDirection: 'column',
  },
  label: {
    fontSize: fontSizes.sm,
    color: colors.textSecondary,
  },
  valueWrapInline: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    marginLeft: spacing.md,
  },
  valueWrapMultiline: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  value: {
    fontSize: fontSizes.body,
    color: colors.textPrimary,
  },
  valueInline: {
    textAlign: 'right',
    flexShrink: 1,
  },
  valueMultiline: {
    textAlign: 'left',
  },
  placeholder: {
    color: colors.textMuted,
  },
  chevron: {
    fontSize: fontSizes.md,
    color: colors.textMuted,
    marginLeft: spacing.sm,
  },
});
