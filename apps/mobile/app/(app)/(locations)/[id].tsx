import { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getLocationById, getStockAtLocation,
  StockAtLocation, Location,
} from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { getDb } from '../../../src/db/schema';

export default function LocationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canManage = usePermission('manage_locations');
  const canUpload = usePermission('upload_media');

  const [location] = useState<Location | null>(() => getLocationById(id));
  const [stock] = useState<StockAtLocation[]>(() => getStockAtLocation(id));

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const userMap = useMemo<Map<string, string>>(
    () => new Map(allUsers.map(u => [u.id, u.name])),
    [allUsers],
  );

  const parentName = useMemo<string | null>(() => {
    if (!location?.parent_id) return null;
    const parent = getLocationById(location.parent_id);
    return parent?.name ?? null;
  }, [location?.parent_id]);

  const ownerName = useMemo<string | null>(() => {
    if (!location?.owner_user_id) return null;
    return userMap.get(location.owner_user_id) ?? location.owner_user_id;
  }, [location?.owner_user_id, userMap]);

  if (!location) {
    return (
      <>
        <Stack.Screen options={{ title: 'Location', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Location not found.</Text></View>
      </>
    );
  }

  function handleArchive() {
    if (!location) return;
    Alert.alert(
      'Archive Location',
      `Archive "${location.name}"? It will be hidden from active lists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            const now = new Date().toISOString();
            getDb().executeSync(
              `UPDATE locations SET active=0, updated_at=? WHERE id=?`,
              [now, id]
            );
            appendOutbox('UPDATE', 'locations', { id, active: false, updated_at: now });
            router.back();
          },
        },
      ]
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: location.name, headerShown: true }} />
      <ScrollView contentContainerStyle={s.content}>

        {/* ── Header card ────────────────────────────────────────────── */}
        <View style={s.card}>
          {location.active === 0 && (
            <View style={s.archivedBanner}>
              <Text style={s.archivedText}>Archived</Text>
            </View>
          )}
          <Text style={s.name}>{location.name}</Text>
          {!!parentName && (
            <View style={[s.attrRow, s.divider]}>
              <Text style={s.attrKey}>Sub-area of</Text>
              <Text style={s.attrVal}>{parentName}</Text>
            </View>
          )}
          {!!ownerName && (
            <View style={s.attrRow}>
              <Text style={s.attrKey}>Owner</Text>
              <Text style={s.attrVal}>{ownerName}</Text>
            </View>
          )}
        </View>

        {/* ── Stock here ─────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>Stock here</Text>
        <View style={s.card}>
          {stock.length === 0 ? (
            <Text style={s.muted}>No count-based stock at this location.</Text>
          ) : (
            stock.map((row, i) => (
              <View
                key={row.item_id}
                style={[s.stockRow, i < stock.length - 1 && s.divider]}
              >
                <Text style={s.stockName} numberOfLines={1}>{row.name}</Text>
                <Text style={s.stockQty}>{row.quantity}</Text>
              </View>
            ))
          )}
        </View>

        {/* ── Photos ─────────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>Photos</Text>
        <MediaGallery entityType="location" entityId={id} canUpload={canUpload} />

        {/* ── Archive button ──────────────────────────────────────────── */}
        {canManage && location.active === 1 && (
          <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={handleArchive}>
            <Text style={s.btnDangerText}>Archive Location</Text>
          </TouchableOpacity>
        )}

      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: '#94A3B8' },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: '#EEF2F7',
  },
  name: { fontSize: 22, fontWeight: '700', color: '#1E3A5F', marginBottom: 4 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: 14, color: '#64748B' },
  attrVal: {
    fontSize: 14, color: '#1E293B', fontWeight: '600',
    maxWidth: '60%', textAlign: 'right',
  },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },

  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },

  stockRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingVertical: 12,
  },
  stockName: { fontSize: 15, color: '#1E293B', fontWeight: '500', flex: 1, marginRight: 8 },
  stockQty: { fontSize: 15, fontWeight: '700', color: '#15803D' },

  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  btnDanger: { backgroundColor: '#FEE2E2' },
  btnDangerText: { color: '#991B1B', fontWeight: '700', fontSize: 16 },

  archivedBanner: {
    backgroundColor: '#FEF3C7', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
    marginBottom: 10, alignSelf: 'flex-start',
  },
  archivedText: { color: '#92400E', fontWeight: '700', fontSize: 12 },
});
