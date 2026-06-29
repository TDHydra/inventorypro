import JobQuickAdd from '../../../src/components/quickadd/JobQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddJobScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Job">
      {onSaved => <JobQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
