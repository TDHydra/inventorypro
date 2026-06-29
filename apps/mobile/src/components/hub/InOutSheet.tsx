import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FilterChip } from '../ui/FilterChip';
import { AppInput } from '../ui/AppInput';
import { colors } from '../../theme';
import type { InventoryItem } from '../../db/queries/items';

interface Props {
  visible: boolean;
  item: InventoryItem | null;
  onChoose: (dir: 'in' | 'out', qty: number) => void;
  onClose: () => void;
}

// "Check In or Check Out?" + qty stepper. Default direction Out, default qty 1.
// "Continue" parses qty (parseFloat, must be > 0) and reports the choice.
export function InOutSheet({ visible, item, onChoose, onClose }: Props) {
  const [direction, setDirection] = useState<'in' | 'out'>('out');
  const [qty, setQty] = useState('1');

  // Reset to defaults each time the sheet opens for a fresh item.
  useEffect(() => {
    if (visible) {
      setDirection('out');
      setQty('1');
    }
  }, [visible]);

  const onContinue = () => {
    const n = parseFloat(qty);
    if (!(n > 0)) return;
    onChoose(direction, n);
  };

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
        onChangeText={setQty}
        keyboardType="decimal-pad"
        placeholder="1"
        autoFocus
      />
      <PrimaryButton
        label="Continue"
        onPress={onContinue}
        disabled={!(parseFloat(qty) > 0)}
        style={{ marginTop: 12 }}
      />
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 },
});
