import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { ModalSheet } from '../ui/ModalSheet';
import { LockerPanel } from './LockerPanel';

// LockerSheet (#126) — tap a locker anywhere (location list, search results)
// and see its full panel in place, mirroring VehicleSheet's
// {locationId, visible, onClose} shape. "Open full page" goes to the locker's
// location detail (a locker IS a location — no dedicated route). Any
// navigation the panel emits (e.g. "Check out from here") closes the sheet
// first, then routes.

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

export function LockerSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  function navigate(href: string) {
    onClose();
    router.push(href as Href);
  }

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      <LockerPanel locationId={locationId} variant="full" onNavigate={navigate} />
      <TouchableOpacity
        style={s.fullPageRow}
        onPress={() => {
          onClose();
          router.push({ pathname: '/(app)/(locations)/[id]', params: { id: locationId } });
        }}
      >
        <Text style={s.fullPageText}>Open full page</Text>
      </TouchableOpacity>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fullPageRow: { paddingVertical: 12, alignItems: 'center' },
  fullPageText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
});
