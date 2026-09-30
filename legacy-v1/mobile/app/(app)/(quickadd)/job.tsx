import JobQuickAdd from '../../../src/components/quickadd/JobQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddJobScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Job" wrapForm={false}>
      {onSaved => <JobQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
