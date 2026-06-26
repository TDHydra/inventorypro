import { View, Image, Text, StyleSheet } from 'react-native';
import { getPrimaryMedia } from '../db/queries/media';

interface Props {
  entityType: string;
  entityId: string;
  size?: number;
}

export function MediaThumbnail({ entityType, entityId, size = 44 }: Props) {
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
    <View style={[styles.placeholder, { width: size, height: size }]}>
      <Text style={styles.icon}>🖼</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    borderRadius: 8,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
  },
});
