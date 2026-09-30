import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FilterChip } from '../ui/FilterChip';
import { AppInput } from '../ui/AppInput';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { parseQuantity } from '../../lib/validation';
import type { InventoryItem } from '../../db/queries/items';

interface Props {
  visible: boolean;
  item: InventoryItem | null;
  onChoose: (dir: 'in' | 'out', qty: number) => void;
  onClose: () => void;
  // #139: an optional secondary action for scoped check-outs — "take it with
  // me" stays the one-tap primary, this opens the destination picker (another
  // location / vehicle / locker / job). Only shown for a check-OUT.
  secondaryLabel?: string;
  onSecondary?: (dir: 'in' | 'out', qty: number) => void;
  // #83/#139: which direction the sheet opens on. Fast Check-In enters with
  // 'in' so the button/labels reflect a check-IN instead of defaulting to Out.
  defaultDirection?: 'in' | 'out';
}

// "Check In or Check Out?" + qty stepper. Default direction Out, default qty 1.
// "Continue" parses qty (NaN + MAX_QUANTITY bound) and reports the choice.
export function InOutSheet({ visible, item, onChoose, onClose, secondaryLabel, onSecondary, defaultDirection = 'out' }: Props) {
  const s = useThemedStyles(makeStyles);
  const [direction, setDirection] = useState<'in' | 'out'>(defaultDirection);
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);

  // Reset to defaults each time the sheet opens for a fresh item — honoring the
  // caller's default direction (Fast Check-In opens on 'in').
  useEffect(() => {
    if (visible) {
      setDirection(defaultDirection);
      setQty('1');
      setError(null);
    }
  }, [visible, defaultDirection]);

  // Parse+validate qty once, then hand off to primary (onChoose) or the
  // optional secondary (onSecondary) action.
  const dispatch = (fn: (dir: 'in' | 'out', qty: number) => void) => {
    // Reject NaN / ≤0 / overflow (e.g. "1e308") with a clear inline message
    // instead of silently doing nothing.
    const parsed = parseQuantity(qty);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    fn(direction, parsed.value);
  };
  const onContinue = () => dispatch(onChoose);

  // The secondary destination action only makes sense for a check-OUT.
  const showSecondary = !!onSecondary && !!secondaryLabel && direction === 'out';

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.title}>{item?.name ?? 'Item'}</Text>
      <View style={s.chipRow}>
        <FilterChip label="Check In" active={direction === 'in'} onPress={() => setDirection('in')} />
        <FilterChip label="Check Out" active={direction === 'out'} onPress={() => setDirection('out')} />
      </View>
      <Text style={s.label}>Quantity</Text>
      <AppInput
        value={qty}
        onChangeText={(t) => { setQty(t); if (error) setError(null); }}
        keyboardType="decimal-pad"
        placeholder="1"
        autoFocus
      />
      {error && <Text style={s.error}>{error}</Text>}
      <PrimaryButton
        label={showSecondary ? 'Take it with me' : 'Continue'}
        onPress={onContinue}
        disabled={!parseQuantity(qty).ok}
        style={{ marginTop: 12 }}
      />
      {showSecondary && (
        <TouchableOpacity
          onPress={() => dispatch(onSecondary!)}
          disabled={!parseQuantity(qty).ok}
          style={s.secondaryBtn}
        >
          <Text style={s.secondaryText}>{secondaryLabel!}</Text>
        </TouchableOpacity>
      )}
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600', color: t.colors.textSecondary, marginBottom: 6 },
  error: { fontSize: 13, color: t.colors.danger, marginTop: 6 },
  secondaryBtn: { marginTop: 10, paddingVertical: 10, alignItems: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600', color: t.colors.brand },
});
