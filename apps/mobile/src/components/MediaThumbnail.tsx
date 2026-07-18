import { View, Image, Text, StyleSheet } from 'react-native';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { getPrimaryMedia } from '../db/queries/media';

interface Props {
  entityType: string;
  entityId: string;
  size?: number;
}

export function MediaThumbnail({ entityType, entityId, size = 44 }: Props) {
  const s = useThemedStyles(makeStyles);
  const record = getPrimaryMedia(entityType, entityId);

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
