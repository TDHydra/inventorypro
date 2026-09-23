import { Redirect, useLocalSearchParams } from 'expo-router';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';
import ItemQuickAdd from '../../../src/components/quickadd/ItemQuickAdd';
import LocationQuickAdd from '../../../src/components/quickadd/LocationQuickAdd';
import StockQuickAdd from '../../../src/components/quickadd/StockQuickAdd';
import EquipmentQuickAdd from '../../../src/components/quickadd/EquipmentQuickAdd';
import UserQuickAdd from '../../../src/components/quickadd/UserQuickAdd';
import TeamQuickAdd from '../../../src/components/quickadd/TeamQuickAdd';
import JobQuickAdd from '../../../src/components/quickadd/JobQuickAdd';
import VehicleQuickAdd from '../../../src/components/quickadd/VehicleQuickAdd';
import GasReceiptQuickAdd from '../../../src/components/quickadd/GasReceiptQuickAdd';
import RepairQuickAdd from '../../../src/components/quickadd/RepairQuickAdd';
import CsvImport from '../../../src/components/CsvImport';

/**
 * Single dynamic route replacing the old app's 11 per-kind
 * `(app)/(quickadd)/<kind>.tsx` wrapper screens (each just mounted a sheet
 * component through QuickAddScreenShell). `sheet` is the kind; unknown kinds
 * redirect back to the chooser.
 *
 * Station C4 (repair) closed out the last known-but-unbuilt kind — every
 * entry in KIND_TITLES now renders its real form (the "coming soon"
 * placeholder this route used to fall back to has been removed as dead
 * code; an unrecognized `sheet` param still redirects to the chooser).
 */
const KIND_TITLES: Record<string, string> = {
  item: 'Quick Add — Item',
  location: 'Quick Add — Location',
  stock: 'Quick Add — Stock',
  equipment: 'Quick Add — Equipment',
  'csv-import': 'Quick Add — Import CSV',
  user: 'Quick Add — User',
  team: 'Quick Add — Team',
  vehicle: 'Quick Add — Vehicle',
  'gas-receipt': 'Quick Add — Gas Receipt',
  job: 'Quick Add — Job',
  repair: 'Quick Add — Repair',
};

export default function QuickAddSheetScreen() {
  const { sheet } = useLocalSearchParams<{ sheet: string }>();
  const title = sheet ? KIND_TITLES[sheet] : undefined;

  if (!title) return <Redirect href="/(app)/quickadd" />;

  switch (sheet) {
    case 'item':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <ItemQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'location':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <LocationQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'stock':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <StockQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'equipment':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <EquipmentQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'csv-import':
      return (
        <QuickAddScreenShell title={title}>
          {onSaved => <CsvImport onImported={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'user':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <UserQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'team':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <TeamQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'job':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <JobQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'vehicle':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <VehicleQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'gas-receipt':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <GasReceiptQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    case 'repair':
      return (
        <QuickAddScreenShell title={title} wrapForm={false}>
          {onSaved => <RepairQuickAdd onSaved={onSaved} />}
        </QuickAddScreenShell>
      );
    default:
      return <Redirect href="/(app)/quickadd" />;
  }
}
