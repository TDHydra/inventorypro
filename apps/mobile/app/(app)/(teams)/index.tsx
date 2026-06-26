import { useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { getDb } from '../../../src/db/schema';
import { rowsAs } from '../../../src/db/schema';

interface Team { id: string; name: string; type: string; manager_id: string | null }

function getTeams(): Team[] {
  const db = getDb();
  const result = db.executeSync(`SELECT * FROM teams ORDER BY name ASC`);
  return rowsAs<Team>(result.rows);
}

export default function TeamsScreen() {
  const router = useRouter();
  const teams = useMemo(() => getTeams(), []);

  return (
    <>
      <Stack.Screen options={{ title: 'Teams', headerShown: true }} />
      <View style={s.container}>
        <FlatList
          data={teams}
          keyExtractor={t => t.id}
          contentContainerStyle={s.list}
          renderItem={({ item: team }) => (
            <TouchableOpacity
              style={s.card}
              onPress={() => router.push({ pathname: '/(app)/(teams)/[id]', params: { id: team.id } })}
            >
              <Text style={s.name}>{team.name}</Text>
              <Text style={s.type}>{team.type}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>No teams set up yet</Text>
            </View>
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  list: { padding: 12, gap: 8 },
  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  name: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  type: { fontSize: 12, color: '#64748B', marginTop: 2, textTransform: 'capitalize' },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#94A3B8' },
});
