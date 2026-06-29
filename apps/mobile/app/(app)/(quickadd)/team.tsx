import TeamQuickAdd from '../../../src/components/quickadd/TeamQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddTeamScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Team">
      {onSaved => <TeamQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
