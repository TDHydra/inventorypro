import EquipmentQuickAdd from '../../../src/components/quickadd/EquipmentQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddEquipmentScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Equipment" wrapForm={false}>
      {onSaved => <EquipmentQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
