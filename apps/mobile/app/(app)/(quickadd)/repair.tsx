import RepairQuickAdd from '../../../src/components/quickadd/RepairQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddRepairScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Repair">
      {onSaved => <RepairQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
