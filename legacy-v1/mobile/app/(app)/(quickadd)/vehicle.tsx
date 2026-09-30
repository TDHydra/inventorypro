import VehicleQuickAdd from '../../../src/components/quickadd/VehicleQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddVehicleScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Vehicle" wrapForm={false}>
      {onSaved => <VehicleQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
