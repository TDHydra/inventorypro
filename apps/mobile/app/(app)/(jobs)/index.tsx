import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { getOpenJobs, searchJobs, getActiveCheckoutsForUser } from '../../../src/db/queries/jobs';
import { rowsAs } from '../../../src/db/schema';

interface Job { id: string; name: string; status: string; created_at: string }
interface Checkout {
  log_id: string; entity_id: string; item_name: string;
  unit: string; unit_category: string; quantity: number;
  from_location_id: string | null; job_id: string | null;
  job_name: string | null; created_at: string;
}

type Tab = 'my' | 'all';

export default function JobsScreen() {
  const { user } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('my');
  const [search, setSearch] = useState('');

  const myCheckouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user]);

  const allJobs = useMemo(() => {
    if (search.trim()) return rowsAs<Job>(searchJobs(search));
    return rowsAs<Job>(getOpenJobs());
  }, [search]);

  return (
    <>
      <Stack.Screen options={{ title: 'Jobs', headerShown: true }} />
      <View style={s.container}>
        {/* Tabs */}
        <View style={s.tabs}>
          <TouchableOpacity style={[s.tab, tab === 'my' && s.tabActive]} onPress={() => setTab('my')}>
            <Text style={[s.tabText, tab === 'my' && s.tabTextActive]}>My Checkouts</Text>
            {myCheckouts.length > 0 && (
              <View style={s.badge}><Text style={s.badgeText}>{myCheckouts.length}</Text></View>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab === 'all' && s.tabActive]} onPress={() => setTab('all')}>
            <Text style={[s.tabText, tab === 'all' && s.tabTextActive]}>All Jobs</Text>
          </TouchableOpacity>
        </View>

        {tab === 'my' ? (
          <FlatList
            data={myCheckouts}
            keyExtractor={c => c.log_id}
            contentContainerStyle={s.list}
            renderItem={({ item }) => (
              <View style={s.card}>
                <Text style={s.cardName}>{item.item_name}</Text>
                <Text style={s.cardSub}>
                  {item.quantity} {item.unit}{item.job_name ? ` · ${item.job_name}` : ''}
                </Text>
                <Text style={s.cardDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
              </View>
            )}
            ListEmptyComponent={
              <View style={s.empty}>
                <Text style={s.emptyText}>No active checkouts</Text>
              </View>
            }
          />
        ) : (
          <>
            <View style={s.searchBox}>
              <TextInput
                style={s.searchInput}
                placeholder="Search jobs..."
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
              />
            </View>
            <FlatList
              data={allJobs}
              keyExtractor={j => j.id}
              contentContainerStyle={s.list}
              renderItem={({ item: job }) => (
                <TouchableOpacity
                  style={s.card}
                  onPress={() => router.push({ pathname: '/(app)/(jobs)/[id]', params: { id: job.id } })}
                >
                  <Text style={s.cardName}>{job.name}</Text>
                  <View style={s.cardRow}>
                    <View style={[s.statusDot, job.status === 'open' && s.statusOpen]} />
                    <Text style={s.cardSub}>{job.status}</Text>
                    <Text style={s.cardDate}>{new Date(job.created_at).toLocaleDateString()}</Text>
                  </View>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <View style={s.empty}>
                  <Text style={s.emptyText}>No jobs found</Text>
                </View>
              }
            />
          </>
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  tabs: { flexDirection: 'row', backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#E2E8F0' },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#2563EB' },
  tabText: { fontSize: 14, color: '#64748B', fontWeight: '600' },
  tabTextActive: { color: '#2563EB' },
  badge: { backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  searchBox: { padding: 12 },
  searchInput: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 42, fontSize: 14, color: '#1E293B',
  },
  list: { padding: 12, gap: 8 },
  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  cardName: { fontSize: 15, fontWeight: '600', color: '#1E293B', marginBottom: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardSub: { fontSize: 12, color: '#64748B' },
  cardDate: { fontSize: 12, color: '#94A3B8', marginLeft: 'auto' as any },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#CBD5E1' },
  statusOpen: { backgroundColor: '#22C55E' },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#94A3B8' },
});
