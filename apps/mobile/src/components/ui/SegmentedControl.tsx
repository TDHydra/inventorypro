/**
 * SegmentedControl — a pill-shaped segmented picker for switching between a
 * few views/kinds on one screen (e.g. product vs equipment, list vs map,
 * open vs closed). Replaces ad-hoc rows of buttons.
 *
 * Usage:
 *   const [kind, setKind] = useState('product');
 *   <SegmentedControl
 *     segments={[
 *       { id: 'product', label: 'Product' },
 *       { id: 'equipment', label: 'Equipment', badge: 3 },
 *     ]}
 *     value={kind}
 *     onChange={setKind}
 *   />
 *
 * With more than 4 segments the control scrolls horizontally instead of
 * splitting the available width evenly. No animated thumb — a plain style
 * swap on tap (reanimated is absent from this app).
 */
import { View, ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { colors, spacing, radii, fontSizes } from '../../theme';

export interface Segment { id: string; label: string; badge?: number }

interface Props {
  segments: Segment[];
  value: string;
  onChange: (id: string) => void;
  size?: 'sm' | 'md';
}

export function SegmentedControl({ segments, value, onChange, size = 'md' }: Props) {
  const scrolls = segments.length > 4;
  const sizeStyle = size === 'sm' ? s.segmentSm : s.segmentMd;
  const textSizeStyle = size === 'sm' ? s.textSm : s.textMd;

  const items = segments.map((seg) => {
    const selected = seg.id === value;
    return (
      <Pressable
        key={seg.id}
        onPress={() => onChange(seg.id)}
        style={[s.segment, sizeStyle, !scrolls && s.segmentFlex, selected && s.segmentSelected]}
      >
        <Text style={[s.text, textSizeStyle, selected ? s.textSelected : s.textUnselected]} numberOfLines={1}>
          {seg.label}
        </Text>
        {seg.badge != null && (
          <View style={[s.badge, selected && s.badgeSelected]}>
            <Text style={[s.badgeText, selected && s.badgeTextSelected]}>{seg.badge}</Text>
          </View>
        )}
      </Pressable>
    );
  });

  if (scrolls) {
    return (
      <View style={s.container}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.scrollContent}>
          {items}
        </ScrollView>
      </View>
    );
  }

  return <View style={s.container}>{items}</View>;
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scrollContent: { flexDirection: 'row' },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  segmentFlex: { flex: 1 },
  segmentMd: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  segmentSm: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
  segmentSelected: { backgroundColor: colors.primaryBg },
  text: { fontWeight: '600' },
  textMd: { fontSize: fontSizes.body },
  textSm: { fontSize: fontSizes.body2 },
  textSelected: { color: colors.primary },
  textUnselected: { color: colors.textSecondary },
  badge: {
    marginLeft: spacing.xs,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: radii.sm,
    backgroundColor: colors.primaryBgStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSelected: { backgroundColor: colors.primary },
  badgeText: { fontSize: fontSizes.xs, fontWeight: '700', color: colors.textSecondary },
  badgeTextSelected: { color: colors.surface },
});
