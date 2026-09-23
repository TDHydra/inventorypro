import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ModalSheet, useThemedStyles, type Theme } from '@invenpro/ui';
import { VehiclePanel } from './VehiclePanel';

/**
 * Panel → Sheet → thin Route (the #122 embed contract): the in-place popup for
 * tapping a vehicle in any list. Full VehiclePanel plus an "Open full page"
 * escape hatch to /vehicles/[id].
 *
 * Station C3 deviation from apps/mobile: the old app's route was the
 * parenthesized group `(vehicles)`; mobile-v2 uses the plain `vehicles`
 * segment (established convention from Stations B/C1/C2).
 */
interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

export function VehicleSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  function openFullPage() {
    onClose();
    router.push({ pathname: '/(app)/vehicles/[id]', params: { id: locationId } });
  }

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      <VehiclePanel locationId={locationId} variant="full" />
      <TouchableOpacity style={s.fullPageBtn} onPress={openFullPage}>
        <Text style={s.fullPageText}>Open full page ›</Text>
      </TouchableOpacity>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fullPageBtn: { alignItems: 'center', paddingVertical: t.spacing.md, marginTop: t.spacing.sm },
  fullPageText: { color: t.colors.primaryText, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
});
