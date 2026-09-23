import { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { PrimaryButton, useThemedStyles, type Theme } from '@invenpro/ui';
import { AddServiceRecordSheet } from '../vehicles/AddServiceRecordSheet';

// Ported from apps/mobile/src/components/quickadd/GasReceiptQuickAdd.tsx (33
// ln, Station C3). QuickAdd host for gas receipts (#168): opens the merged
// Log Service sheet (no fixed vehicle → picker defaults to the active
// checkout) on the Fuel-up kind. After a save (or a cancel) the shell stays
// up with an add-another button. The shell's toast/counter fire via onSaved
// only on real saves.
//
// Per the standing porting rule: gas receipts were merged INTO
// AddServiceRecordSheet in the old app (no parallel form) — this component
// stays a thin host, exactly like its old-app source.
export default function GasReceiptQuickAdd({ onSaved }: { onSaved: (label: string, createdId?: string) => void }) {
  const s = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(true);
  return (
    <View style={s.body}>
      <PrimaryButton label="+ Add Gas Receipt" onPress={() => setOpen(true)} />
      <AddServiceRecordSheet
        visible={open}
        initialKind="fuel_up"
        onClose={() => setOpen(false)}
        onSaved={() => onSaved('Gas receipt')}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  body: { padding: t.spacing.base },
});
