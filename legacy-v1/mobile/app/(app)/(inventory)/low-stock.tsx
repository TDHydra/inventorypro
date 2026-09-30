import { View, FlatList, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useMemo } from 'react';
import { getLowStockItems } from '../../../src/db/queries/items';
import { getItemTypeColorMap } from '../../../src/db/queries/taxonomy';
import { ItemCard } from '../../../src/components/ItemCard';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import type { Theme } from '../../../src/themes/types';

// #144: the dashboard's low-stock quick-action lands here — every low-stock
// item rendered with the same ItemCard presentation as the Item Catalog.
export default function LowStockScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const dataVersion = useDataVersion();
  const items = useMemo(() => getLowStockItems(), [dataVersion]);
  const typeColorMap = useMemo(() => getItemTypeColorMap(), [dataVersion]);

  const handleCheckout = (itemId: string) => {
    router.push({ pathname: '/(app)/(checkout)', params: { itemId } });
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Low Stock', headerShown: true }} />
      <FlatList
        style={s.container}
        contentContainerStyle={s.content}
        data={items}
        keyExtractor={i => i.id}
        renderItem={({ item }) => (
          <ItemCard item={item} onCheckout={handleCheckout} typeColorMap={typeColorMap} />
        )}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyText}>Nothing is low on stock right now.</Text>
          </View>
        }
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: 14, color: t.colors.textSecondary },
});
