import { Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ModalSheet, useThemedStyles, type Theme } from '@invenpro/ui';
import { LockerPanel } from './LockerPanel';

// LockerSheet (#126) — tap a locker anywhere (location list, search results)
// and see its full panel in place, mirroring VehicleSheet's
// {locationId, visible, onClose} shape. "Open full page" goes to the locker's
// dedicated detail route.
//
// Station C3 deviation from apps/mobile: the old app's route was the
// parenthesized group `(lockers)`; mobile-v2 uses the plain `lockers`
// segment (established convention, matching VehicleSheet's route fix).

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

export function LockerSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      <LockerPanel locationId={locationId} variant="full" />
      <TouchableOpacity
        style={s.fullPageRow}
        onPress={() => {
          onClose();
          router.push({ pathname: '/(app)/lockers/[id]', params: { id: locationId } });
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
