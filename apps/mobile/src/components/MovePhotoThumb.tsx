import { useMemo, useState } from 'react';
import {
  Text, Image, Modal, ScrollView, TouchableOpacity, StyleSheet, Dimensions,
} from 'react-native';
import type { Theme } from '../themes/types';
import { useTableVersion } from '../hooks/useDataVersion';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { getPrimaryMedia, getMediaForEntity, MediaRecord } from '../db/queries/media';

const SCREEN_WIDTH = Dimensions.get('window').width;

/**
 * Trailing thumbnail for an activity_log entry that carries a move-photo.
 * Checkout/checkin photos attach as media with entity_type='activity_log' and
 * entity_id = the log entry's id, so any log row (item, equipment_unit, …) can
 * surface its photo here. Renders nothing when the entry has no media. Tapping
 * opens a full-screen, swipeable lightbox. Self-contained so it can drop into
 * any log list row (e.g. the global activity feed) without screen-level state.
 */
export function MovePhotoThumb({ logId }: { logId: string }) {
  const s = useThemedStyles(makeStyles);
  // Re-read when a sync pull touches media so a photo that arrives after the
  // log row rendered still shows up.
  const mediaVersion = useTableVersion(['media']);
  const primary = useMemo<MediaRecord | null>(
    () => getPrimaryMedia('activity_log', logId),
    [logId, mediaVersion],
  );
  const [open, setOpen] = useState<MediaRecord[] | null>(null);

  if (!primary) return null;

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(getMediaForEntity('activity_log', logId))}
        style={s.thumbBtn}
      >
        <Image source={{ uri: primary.thumbnail_url ?? primary.url }} style={s.thumbImg} />
      </TouchableOpacity>

      <Modal visible={open !== null} transparent animationType="fade">
        <TouchableOpacity style={s.lightbox} onPress={() => setOpen(null)} activeOpacity={1}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            style={{ width: SCREEN_WIDTH }}
            contentContainerStyle={s.lightboxScroll}
          >
            {(open ?? []).map((m, i) => (
              <Image
                key={i}
                source={{ uri: m.url }}
                style={[s.lightboxImg, { width: SCREEN_WIDTH }]}
                resizeMode="contain"
              />
            ))}
          </ScrollView>
          <Text style={s.lightboxClose}>✕ Tap to close</Text>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  thumbBtn: { marginLeft: 8 },
  thumbImg: { width: 36, height: 36, borderRadius: 6, backgroundColor: t.colors.border },
  lightbox: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  lightboxScroll: { alignItems: 'center' },
  lightboxImg: { height: '80%' },
  lightboxClose: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    color: '#fff',
    fontSize: 16,
  },
});
