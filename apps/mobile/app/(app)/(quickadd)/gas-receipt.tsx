import GasReceiptQuickAdd from '../../../src/components/quickadd/GasReceiptQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddGasReceiptScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Gas Receipt" wrapForm={false}>
      {onSaved => <GasReceiptQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
