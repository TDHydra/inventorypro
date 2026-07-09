import { ModalSheet } from '../ui/ModalSheet';
import ItemQuickAdd from './ItemQuickAdd';
import StockQuickAdd from './StockQuickAdd';
import EquipmentQuickAdd from './EquipmentQuickAdd';
import LocationQuickAdd from './LocationQuickAdd';
import VehicleQuickAdd from './VehicleQuickAdd';
import JobQuickAdd from './JobQuickAdd';
import RepairQuickAdd from './RepairQuickAdd';
import TeamQuickAdd from './TeamQuickAdd';
import UserQuickAdd from './UserQuickAdd';

export type QuickCreateKind =
  | 'item' | 'stock' | 'equipment' | 'location' | 'vehicle'
  | 'job' | 'repair' | 'team' | 'user';

interface Props {
  visible: boolean;
  kind: QuickCreateKind;
  /** Forward-compat: forms don't accept an initial name yet, so this is ignored for now. */
  initialName?: string;
  onClose: () => void;
  onCreated: (entity: { id: string; label: string }) => void;
}

/**
 * Reusable bottom-sheet wrapper that runs a quick-add form inline. When the form
 * reports a created entity id, we surface it via `onCreated` and close the sheet.
 */
export function QuickCreateSheet({ visible, kind, initialName: _initialName, onClose, onCreated }: Props) {
  const onSaved = (label: string, createdId?: string) => {
    if (createdId) onCreated({ id: createdId, label });
    onClose();
  };

  // Switch is written so later phases can add more kinds (default returns null).
  function renderForm() {
    switch (kind) {
      case 'item':
        return <ItemQuickAdd onSaved={onSaved} />;
      case 'stock':
        return <StockQuickAdd onSaved={onSaved} />;
      case 'equipment':
        return <EquipmentQuickAdd onSaved={onSaved} />;
      case 'location':
        return <LocationQuickAdd onSaved={onSaved} />;
      case 'vehicle':
        return <VehicleQuickAdd onSaved={onSaved} />;
      case 'job':
        return <JobQuickAdd onSaved={onSaved} />;
      case 'repair':
        return <RepairQuickAdd onSaved={onSaved} />;
      case 'team':
        return <TeamQuickAdd onSaved={onSaved} />;
      case 'user':
        return <UserQuickAdd onSaved={onSaved} />;
      default:
        return null;
    }
  }

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      {renderForm()}
    </ModalSheet>
  );
}
