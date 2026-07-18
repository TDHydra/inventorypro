import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

export interface BulkAction {
  key: string;
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  count: number;
  actions: BulkAction[];
  onSelectAll?: () => void;
  onCancel: () => void;
  disabled?: boolean;
}

/**
 * Sticky bottom action bar for multi-select mode.
 * Shows "N selected", a Select-all (optional), a Cancel, and the action buttons.
 * Destructive actions are styled red. `disabled` greys the action buttons
 * (e.g. when writes are blocked by maintenance mode). Pure/reusable — no
 * business logic.
 */
export function BulkActionBar({ count, actions, onSelectAll, onCancel, disabled }: Props) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.bar}>
      <View style={s.topRow}>
        <Text style={s.count}>{count} selected</Text>
        <View style={s.topRight}>
          {onSelectAll && (
            <TouchableOpacity onPress={onSelectAll} activeOpacity={0.7} style={s.linkBtn}>
              <Text style={s.link}>Select all</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onCancel} activeOpacity={0.7} style={s.linkBtn}>
            <Text style={s.cancel}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.actions}
      >
        {actions.map((a) => (
          <TouchableOpacity
            key={a.key}
            style={[
              s.action,
              a.destructive ? s.actionDanger : s.actionPrimary,
              disabled && s.disabled,
            ]}
            onPress={a.onPress}
            disabled={disabled}
            activeOpacity={0.85}
          >
            <Text style={[s.actionText, a.destructive ? s.actionTextDanger : s.actionTextPrimary]}>
              {a.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: t.colors.surface,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
    paddingHorizontal: t.spacing.lg,
    paddingTop: t.spacing.md,
    paddingBottom: t.spacing.xl,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: t.spacing.md,
  },
  count: { fontSize: t.typography.fontSizes.md, fontWeight: '700', color: t.colors.textPrimary },
  topRight: { flexDirection: 'row', alignItems: 'center' },
  linkBtn: { paddingVertical: t.spacing.xs, paddingHorizontal: t.spacing.sm, marginLeft: t.spacing.sm },
  link: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.primary },
  cancel: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textSecondary },
  actions: { gap: t.spacing.sm, paddingRight: t.spacing.sm },
  action: {
    paddingVertical: 10,
    paddingHorizontal: t.spacing.lg,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionPrimary: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primaryBgStrong },
  actionDanger: { backgroundColor: t.colors.dangerBg, borderColor: t.colors.dangerBg },
  disabled: { opacity: 0.5 },
  actionText: { fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  actionTextPrimary: { color: t.colors.primaryText },
  actionTextDanger: { color: t.colors.danger },
});
