import { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, FlatList, TextInput, TouchableOpacity, Image, StyleSheet,
  Dimensions, RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { MediaDetailSheet } from '../../../src/components/MediaDetailSheet';
import { usePermission } from '../../../src/hooks/usePermission';
import { getMediaHubPage, MediaHubRow, MediaHubFilter } from '../../../src/db/queries/media';
import { syncNow } from '../../../src/sync/engine';
import { useDataVersion } from '../../../src/hooks/useDataVersion';

const { width } = Dimensions.get('window');
// 3-up grid: 12px outer padding both sides + 2×12px gutters = 48 (matches MediaGallery).
const THUMB = (width - 48) / 3;
const PAGE_SIZE = 30;

const FILTERS: { label: string; value: MediaHubFilter }[] = [
  { label: 'Open jobs', value: 'open' },
  { label: 'All jobs', value: 'all' },
  { label: 'Everything', value: 'everything' },
];

export default function MediaHubScreen() {
  // 'everything' surfaces media on non-job entities too — same gate as Activity Logs.
  const canViewAll = usePermission('view_all_logs');

  const [filter, setFilter] = useState<MediaHubFilter>('open');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MediaHubRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((f: MediaHubFilter, q: string, newOffset: number, append = false) => {
    const page = getMediaHubPage(f, q.trim(), PAGE_SIZE, newOffset);
    setRows(prev => (append ? [...prev, ...page] : page));
    setHasMore(page.length === PAGE_SIZE);
    setOffset(newOffset + page.length);
    setLoaded(true);
  }, []);

  useEffect(() => {
    runSearch('open', '', 0);
  }, [runSearch]);

  // If the permission is revoked while 'everything' is active, fall back.
  useEffect(() => {
    if (!canViewAll && filter === 'everything') {
      setFilter('open');
      runSearch('open', query, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewAll]);

  const handleSearch = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(filter, text, 0), 150);
  };

  const handleFilter = (f: MediaHubFilter) => {
    setFilter(f);
    runSearch(f, query, 0);
  };

  const loadMore = () => {
    if (!hasMore) return;
    runSearch(filter, query, offset, true);
  };

  // Re-query the ENTIRE loaded window so a mutation deep in an infinite-scrolled
  // list doesn't truncate it back to page 1 (mirrors the inventory list).
  const reloadWindow = useCallback(() => {
    const limit = Math.max(PAGE_SIZE, offset);
    const page = getMediaHubPage(filter, query.trim(), limit, 0);
    setRows(page);
    setHasMore(page.length === limit);
    setOffset(page.length);
  }, [filter, query, offset]);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    runSearch(filter, query, 0);
    setRefreshing(false);
  }, [refreshing, runSearch, filter, query]);

  // Re-query when a background pull lands new rows so media from other devices
  // appears without pull-to-refresh. Via a ref because reloadWindow's identity
  // changes on every reload (it depends on offset, which it mutates itself).
  const dataVersion = useDataVersion();
  const reloadWindowRef = useRef(reloadWindow);
  reloadWindowRef.current = reloadWindow;
  useEffect(() => {
    if (loaded) reloadWindowRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const emptyTitle = query
    ? `No media matching "${query}"`
    : filter === 'open' ? 'No media on open jobs' : 'No media yet';

  return (
    <>
      <Stack.Screen options={{ title: 'Media', headerShown: true }} />
      <View style={s.container}>
        <View style={s.chipRow}>
          {FILTERS.filter(f => f.value !== 'everything' || canViewAll).map(f => (
            <FilterChip
              key={f.value}
              label={f.label}
              active={filter === f.value}
              onPress={() => handleFilter(f.value)}
            />
          ))}
        </View>

        <TextInput
          style={s.search}
          placeholder="Search job, room, uploader…"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={handleSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />

        {loaded && rows.length > 0 ? (
          <Text style={s.count}>{rows.length}{hasMore ? '+' : ''} item{rows.length === 1 && !hasMore ? '' : 's'}</Text>
        ) : null}

        <FlatList
          data={rows}
          keyExtractor={r => r.id}
          numColumns={3}
          columnWrapperStyle={s.gridRow}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={s.cell} activeOpacity={0.8} onPress={() => setSelectedId(item.id)}>
              <View>
                <Image source={{ uri: item.thumbnail_url ?? item.url }} style={s.thumb} resizeMode="cover" />
                {item.media_type === 'video' && (
                  <View style={s.videoBadge}>
                    <Text style={s.videoIcon}>▶</Text>
                  </View>
                )}
              </View>
              <Text style={s.cellCaption} numberOfLines={1}>
                {item.location_note ?? item.job_name ?? ''}
              </Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            loaded ? (
              <EmptyState
                icon="🖼️"
                title={emptyTitle}
                subtitle="Photos and videos added on jobs show up here."
              />
            ) : null
          }
        />
      </View>

      <MediaDetailSheet
        mediaId={selectedId}
        visible={selectedId !== null}
        onClose={() => setSelectedId(null)}
        onChanged={reloadWindow}
      />
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  chipRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: 12, paddingTop: spacing.md, paddingBottom: spacing.sm, flexWrap: 'wrap' },
  search: {
    marginHorizontal: 12, marginBottom: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.md, height: 44, fontSize: fontSizes.body2, color: colors.textPrimary,
  },
  count: { fontSize: fontSizes.caption, color: colors.textMuted, paddingHorizontal: 12, paddingBottom: spacing.xs },

  list: { padding: 12, paddingBottom: spacing.xxxl },
  gridRow: { gap: 12, marginBottom: 12 },
  cell: { width: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, backgroundColor: colors.border },
  videoBadge: {
    position: 'absolute', top: 0, left: 0, width: THUMB, height: THUMB,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.35)', borderRadius: 8,
  },
  videoIcon: { color: '#fff', fontSize: 24 },
  cellCaption: { fontSize: fontSizes.xs, color: colors.textSecondary, marginTop: 3 },
});
