import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { VehiclePanel } from '../../../src/components/vehicles/VehiclePanel';
import { getLocationById } from '../../../src/db/queries/locations';
import type { Theme } from '../../../src/themes/types';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// Thin full-page wrapper for the embeddable VehiclePanel (Panel → Sheet →
// Route). All data loading/refresh lives in the panel; this route only sets
// the header title.
export default function VehicleDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const locationsVersion = useTableVersion(['locations']);
  const title = useMemo(() => getLocationById(id)?.name ?? 'Vehicle', [id, locationsVersion]);

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <VehiclePanel locationId={id} variant="full" />
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, paddingBottom: 48 },
});
