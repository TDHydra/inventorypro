import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, Image, StyleSheet,
  Dimensions, RefreshControl,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { SearchInput } from '../../../src/components/ui/SearchInput';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { Fab } from '../../../src/components/ui/Fab';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { ErrorView } from '../../../src/components/ui/ErrorView';
import { MediaDetailSheet } from '../../../src/components/MediaDetailSheet';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useMultiSelect } from '../../../src/hooks/useMultiSelect';
import { BulkActionBar, BulkAction } from '../../../src/components/BulkActionBar';
import { Alert } from '../../../src/lib/themedAlert';
import {
  getMediaHubPage, getMediaById, MediaHubRow, MediaHubFilter, deleteBulkMedia,
  getUnseenSharedPoolMediaCount, markSharedPoolMediaSeen,
} from '../../../src/db/queries/media';
import { syncNow } from '../../../src/sync/engine';
import { useDbQuery } from '../../../src/hooks/useDbQuery';
import { openQuickPhoto } from '../../../src/components/quickphoto/QuickPhotoFlow';

const { width } = Dimensions.get('window');
// 3-up grid: 12px outer padding both sides + 2×12px gutters = 48 (matches MediaGallery).
const THUMB = (width - 48) / 3;
const PAGE_SIZE = 30;

const FILTERS: { label: string; value: MediaHubFilter }[] = [
  { label: 'Open jobs', value: 'open' },
  { label: 'All jobs', value: 'all' },
  { label: 'Shared', value: 'shared' },
  { label: 'Everything', value: 'everything' },
];

export default function MediaHubScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  // 'everything' surfaces media on non-job entities too — same gate as Activity Logs.
  const canViewAll = usePermission('view_all_logs');
  const canDelete = usePermission('delete_media');
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<MediaHubRow>();
  // #87: push/inbox deep-link — a shared photo's id, if we were routed here for one.
  const { id: linkedId } = useLocalSearchParams<{ id?: string }>();

  // Open on Shared when photos shared TO this user arrived since they last
  // looked at the Shared tab (lazy init — the watermark check runs once per
  // mount, so switching away sticks for the rest of the visit).
  const [filter, setFilter] = useState<MediaHubFilter>(() => {
    try {
      return user && getUnseenSharedPoolMediaCount(user.id) > 0 ? 'shared' : 'open';
    } catch {
      return 'open';
    }
  });
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<MediaHubRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // #237: getMediaHubPage was uncaught here — a local-read failure (e.g. a
  // malformed row from a bad sync pull) crashed the whole hub instead of
  // leaving a way back. Only the initial (non-append) page sets this so an
  // infinite-scroll failure just stops pagination rather than blanking rows
  // already on screen.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // #171: Fab → "Take photo" / "Choose from gallery" — both hand off to the
  // existing QuickPhotoFlow host (mounted once in app/(app)/_layout.tsx); the
  // destination/audience phase is unchanged, only the source differs.
  const [showAddSheet, setShowAddSheet] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((f: MediaHubFilter, q: string, newOffset: number, append = false) => {
    try {
      const page = getMediaHubPage(f, q.trim(), PAGE_SIZE, newOffset);
      setRows(prev => (append ? [...prev, ...page] : page));
      setHasMore(page.length === PAGE_SIZE);
      setOffset(newOffset + page.length);
      setLoaded(true);
      if (!append) setLoadError(null);
    } catch {
      if (!append) setLoadError('Couldn’t load media.');
      // A persistently failing read would otherwise be re-hit on every
      // onEndReached crossing — stop paginating until a fresh non-append load.
      else setHasMore(false);
    }
  }, []);

  useEffect(() => {
    runSearch(filter, '', 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // #237: same guard as runSearch — this path fires on background pulls
    // (mediaTrigger below), i.e. exactly when a malformed synced row can land,
    // and an uncaught throw here takes down the whole app via the root boundary.
    try {
      const limit = Math.max(PAGE_SIZE, offset);
      const page = getMediaHubPage(filter, query.trim(), limit, 0);
      setRows(page);
      setHasMore(page.length === limit);
      setOffset(page.length);
      setLoadError(null);
    } catch {
      setLoadError('Couldn’t load media.');
    }
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
  // #171: table-scoped to 'media' (useDbQuery, #60) instead of the global
  // useDataVersion() — a pull that never touches media is now a no-op here.
  // The 1-row probe's return is a fresh array on every recompute (fn reruns
  // exactly once per 'media' version bump), so it's a reliable effect trigger
  // even when the change wouldn't alter row *count* (e.g. a caption edit) —
  // same rationale as ChatBell's unreadVersion (src/components/ChatBell.tsx).
  // #237: guarded — this probe reruns synchronously on every 'media' pull; a
  // throw would crash the app, not just this screen. null on failure is stable
  // across recomputes, so a broken read simply stops triggering reloads.
  const mediaTrigger = useDbQuery(() => {
    try { return getMediaHubPage('everything', '', 1, 0); } catch { return null; }
  }, [], ['media']);
  const reloadWindowRef = useRef(reloadWindow);
  reloadWindowRef.current = reloadWindow;
  useEffect(() => {
    if (loaded) reloadWindowRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaTrigger]);

  // Viewing the Shared tab consumes the "new shared photos" state: stamp the
  // per-user watermark so the next visit defaults back to Open jobs (until
  // another share lands). mediaTrigger keeps the stamp fresh while the tab
  // stays open across a background pull.
  useEffect(() => {
    if (filter === 'shared' && user) {
      try { markSharedPoolMediaSeen(user.id); } catch { /* best-effort */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, user?.id, mediaTrigger]);

  // #87: push/inbox deep-link → open the shared photo. The push can beat the
  // pull: if the row isn't local yet, trigger a sync; mediaTrigger changes on
  // the next pull and re-runs this effect, opening the sheet once it lands.
  // Clears the `id` param the moment it's acted on (same idiom as
  // (locations)/index.tsx's createUnder) so a later UNRELATED background
  // sync doesn't re-fire this effect and hijack the sheet the user has since
  // closed or navigated away from. attemptedSyncRef caps our own syncNow()
  // nudge to once per linkedId — getMediaById is still rechecked on every
  // mediaTrigger change either way, so a row that lands via the engine's normal
  // periodic sync still opens the sheet; we just don't re-trigger our own
  // sync over and over for an id that never resolves.
  const attemptedSyncRef = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedId) return;
    if (getMediaById(linkedId)) {
      setSelectedId(linkedId);
      router.setParams({ id: undefined });
      return;
    }
    if (attemptedSyncRef.current === linkedId) return;
    attemptedSyncRef.current = linkedId;
    void syncNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId, mediaTrigger]);

  const emptyTitle = query
    ? `No media matching "${query}"`
    : filter === 'open' ? 'No media on open jobs'
    : filter === 'shared' ? 'No shared photos yet'
    : 'No media yet';

  // Bulk delete — permanently removes selected media (offline-first, same as
  // single delete). Gated on delete_media; server re-checks on sync push.
  const handleBulkDelete = useCallback(() => {
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    if (ids.length === 0) { ms.exit(); return; }
    Alert.alert(
      `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
      'This permanently removes the selected photos and videos from every device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Delete ${ids.length}`,
          style: 'destructive',
          onPress: () => {
            deleteBulkMedia(ids, user?.id ?? null);
            reloadWindow();
            ms.exit();
            void syncNow().catch(() => { /* offline — deletes flush on next sync */ });
          },
        },
      ],
    );
  }, [ms, reloadWindow, user?.id]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    ...(canDelete
      ? [{ key: 'delete', label: 'Delete', destructive: true, onPress: () => { handleBulkDelete(); } } as BulkAction]
      : []),
  ], [canDelete, handleBulkDelete]);

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

        <SearchInput
          style={s.search}
          placeholder="Search job, room, uploader…"
          value={query}
          onChangeText={handleSearch}
        />

        {loaded && rows.length > 0 ? (
          <Text style={s.count}>{rows.length}{hasMore ? '+' : ''} item{rows.length === 1 && !hasMore ? '' : 's'}</Text>
        ) : null}

        {loadError ? (
          <ErrorView message={loadError} onRetry={() => runSearch(filter, query, 0)} />
        ) : (
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
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
            />
          }
          renderItem={({ item }) => {
            const selected = ms.isSelected(item.id);
            return (
              <TouchableOpacity
                style={s.cell}
                activeOpacity={0.8}
                onPress={() => {
                  if (ms.active) { ms.toggle(item.id); return; }
                  setSelectedId(item.id);
                }}
                onLongPress={() => { if (!ms.active) ms.enter(item.id); }}
                delayLongPress={300}
              >
                <View>
                  <Image source={{ uri: item.thumbnail_url ?? item.url }} style={[s.thumb, ms.active && selected && s.thumbSelected]} resizeMode="cover" />
                  {item.media_type === 'video' && !ms.active && (
                    <View style={s.videoBadge}>
                      <Text style={s.videoIcon}>▶</Text>
                    </View>
                  )}
                  {ms.active && (
                    <View style={[s.checkOverlay, selected && s.checkOverlayOn]}>
                      {selected && <Text style={s.checkMark}>✓</Text>}
                    </View>
                  )}
                </View>
                <Text style={s.cellCaption} numberOfLines={1}>
                  {item.location_note ?? item.job_name ?? ''}
                </Text>
              </TouchableOpacity>
            );
          }}
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
        )}
        {ms.active && (
          <BulkActionBar
            count={ms.count}
            actions={bulkActions}
            onSelectAll={() => ms.selectAll(rows.map(r => r.id))}
            onCancel={ms.exit}
            disabled={locked}
          />
        )}

        {!ms.active && !locked && (
          <Fab
            onPress={() => setShowAddSheet(true)}
            label="Share media"
            accessibilityLabel="Share media"
          />
        )}
      </View>

      <MediaDetailSheet
        mediaId={selectedId}
        visible={selectedId !== null}
        onClose={() => setSelectedId(null)}
        onChanged={reloadWindow}
      />

      <ModalSheet visible={showAddSheet} onClose={() => setShowAddSheet(false)}>
        <Text style={s.addSheetTitle}>Share media</Text>
        <TouchableOpacity
          style={s.addSheetRow}
          onPress={() => { setShowAddSheet(false); openQuickPhoto(); }}
        >
          <Text style={s.addSheetIcon}>📷</Text>
          <Text style={s.addSheetLabel}>Take photo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.addSheetRow}
          onPress={() => { setShowAddSheet(false); openQuickPhoto({ source: 'gallery' }); }}
        >
          <Text style={s.addSheetIcon}>🖼️</Text>
          <Text style={s.addSheetLabel}>Choose from gallery</Text>
        </TouchableOpacity>
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  chipRow: { flexDirection: 'row', gap: t.spacing.sm, paddingHorizontal: 12, paddingTop: t.spacing.md, paddingBottom: t.spacing.sm, flexWrap: 'wrap' },
  // Margins + the screen's compact sizing kept as overrides on the SearchInput
  // primitive (box/border/height come from the input descriptor).
  search: {
    marginHorizontal: 12, marginBottom: t.spacing.sm,
    paddingHorizontal: t.spacing.md, fontSize: t.typography.fontSizes.body2,
  },
  count: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, paddingHorizontal: 12, paddingBottom: t.spacing.xs },

  list: { padding: 12, paddingBottom: t.spacing.xxxl },
  gridRow: { gap: 12, marginBottom: 12 },
  cell: { width: THUMB },
  thumb: { width: THUMB, height: THUMB, borderRadius: 8, backgroundColor: t.colors.border },
  thumbSelected: { opacity: 0.65 },
  videoBadge: {
    position: 'absolute', top: 0, left: 0, width: THUMB, height: THUMB,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.35)', borderRadius: 8,
  },
  videoIcon: { color: '#fff', fontSize: 24 },
  cellCaption: { fontSize: t.typography.fontSizes.xs, color: t.colors.textSecondary, marginTop: 3 },
  checkOverlay: {
    position: 'absolute', top: 4, right: 4,
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#fff',
    backgroundColor: 'rgba(15,23,42,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkOverlayOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.onPrimary, fontSize: 13, fontWeight: '700', lineHeight: 16 },

  addSheetTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.base },
  addSheetRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, paddingVertical: 14 },
  addSheetIcon: { fontSize: 22, width: 28, textAlign: 'center' },
  addSheetLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
});
