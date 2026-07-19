import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { LockerPanel } from '../../../src/components/lockers/LockerPanel';
import { getLocationById } from '../../../src/db/queries/locations';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { useTableVersion } from '../../../src/hooks/useDataVersion';

// Thin full-page wrapper for the embeddable LockerPanel (Panel → Sheet →
// Route). All data loading/refresh lives in the panel; this route only sets
// the header title.
export default function LockerDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const locationsVersion = useTableVersion(['locations']);
  const title = useMemo(() => getLocationById(id)?.name ?? 'Locker', [id, locationsVersion]);

  return (
    <>
      <Stack.Screen options={{ title, headerShown: true }} />
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <LockerPanel locationId={id} variant="full" />
      </ScrollView>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, paddingBottom: 48 },
});
