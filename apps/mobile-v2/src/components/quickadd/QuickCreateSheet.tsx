import { ModalSheet } from '@invenpro/ui';
import ItemQuickAdd from './ItemQuickAdd';
import StockQuickAdd from './StockQuickAdd';
import EquipmentQuickAdd from './EquipmentQuickAdd';
import LocationQuickAdd from './LocationQuickAdd';
// TODO(wave-B): VehicleQuickAdd, JobQuickAdd, RepairQuickAdd, TeamQuickAdd,
// UserQuickAdd live under excluded component dirs (vehicles/, jobs/, repairs/,
// crew/) and aren't ported this wave. Their QuickCreateKind cases are stubbed
// below (return null) until those waves land.

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
        // TODO(wave-B): VehicleQuickAdd not ported (vehicles/ excluded this wave).
        return null;
      case 'job':
        // TODO(wave-B): JobQuickAdd not ported (jobs/ excluded this wave).
        return null;
      case 'repair':
        // TODO(wave-B): RepairQuickAdd not ported (repairs/ excluded this wave).
        return null;
      case 'team':
        // TODO(wave-B): TeamQuickAdd not ported (crew/ excluded this wave).
        return null;
      case 'user':
        // TODO(wave-B): UserQuickAdd not ported this wave.
        return null;
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
