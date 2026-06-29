import UserQuickAdd from '../../../src/components/quickadd/UserQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddUserScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — User">
      {onSaved => <UserQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
