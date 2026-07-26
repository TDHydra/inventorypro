import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { GasReceiptSheet } from '../vehicles/GasReceiptSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * QuickAdd host for the gas-receipt sheet (#168): the sheet opens immediately;
 * after a save (or a cancel) the shell stays up with an add-another button, so
 * a crew member can file several receipts in one stop. The shell's toast /
 * counter fire via onSaved only on real saves — closing without saving logs
 * nothing.
 */
export default function GasReceiptQuickAdd({ onSaved }: { onSaved: (label: string, createdId?: string) => void }) {
  const s = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(true);
  return (
    <View style={s.body}>
      <PrimaryButton label="+ Add Gas Receipt" onPress={() => setOpen(true)} />
      <GasReceiptSheet
        visible={open}
        onClose={() => setOpen(false)}
        onSaved={() => onSaved('Gas receipt')}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  body: { padding: t.spacing.base },
});
