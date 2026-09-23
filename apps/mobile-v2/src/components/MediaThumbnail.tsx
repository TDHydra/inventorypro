// Station D2: ported from apps/mobile/src/components/MediaThumbnail.tsx.
// Import mapping: themes/hooks → '@invenpro/ui', useTableVersion → '@invenpro/core',
// db/queries/media → '../repos/media'.
import { useMemo } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { useThemedStyles, type Theme } from '@invenpro/ui';
import { useTableVersion } from '@invenpro/core';
import { getPrimaryMedia } from '../repos/media';

interface Props {
  entityType: string;
  entityId: string;
  size?: number;
}

export function MediaThumbnail({ entityType, entityId, size = 44 }: Props) {
  const s = useThemedStyles(makeStyles);
  // Subscribe to media pulls so the thumbnail self-updates when a primary photo
  // lands via sync, instead of waiting for the parent to happen to re-render.
  const mediaVersion = useTableVersion(['media']);
  const record = useMemo(
    () => getPrimaryMedia(entityType, entityId),
    [entityType, entityId, mediaVersion],
  );

  if (record) {
    return (
      <Image
        source={{ uri: record.thumbnail_url ?? record.url }}
        style={{ width: size, height: size, borderRadius: 8 }}
      />
    );
  }

  return (
    <View style={[s.placeholder, { width: size, height: size }]}>
      <Text style={s.icon}>🖼</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  placeholder: {
    borderRadius: 8,
    backgroundColor: t.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
});
