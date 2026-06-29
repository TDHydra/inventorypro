import LocationQuickAdd from '../../../src/components/quickadd/LocationQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddLocationScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Location">
      {onSaved => <LocationQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
