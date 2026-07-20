import ItemQuickAdd from '../../../src/components/quickadd/ItemQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddItemScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Item" wrapForm={false}>
      {onSaved => <ItemQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
