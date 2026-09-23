// Ported from apps/mobile/app/(app)/(lockers)/[id].tsx (was a parenthesized
// group; plain route here per docs/REBUILD-PORTING.md / Station C3).
// Straight port: thin full-page wrapper for the embeddable LockerPanel
// (Panel → Sheet → Route). All data loading/refresh lives in the panel; this
// route only sets the header title.
import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useThemedStyles, type Theme } from '@invenpro/ui';
import { useTableVersion } from '@invenpro/core';
import { LockerPanel } from '../../../src/components/lockers/LockerPanel';
import { getLocationById } from '../../../src/repos/locations';

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
