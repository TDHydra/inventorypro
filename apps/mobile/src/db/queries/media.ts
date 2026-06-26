import { getDb } from '../schema';

export interface MediaRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  media_type: 'image' | 'video';
  url: string;
  thumbnail_url: string | null;
  caption: string | null;
  is_primary: number;
  uploaded_by: string | null;
  created_at: string;
}

export function getMediaForEntity(entityType: string, entityId: string): MediaRecord[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC`,
    [entityType, entityId]
  );
  return result.rows as unknown as MediaRecord[];
}

export function getPrimaryMedia(entityType: string, entityId: string): MediaRecord | null {
  const db = getDb();
  const result = db.executeSync(
    `SELECT * FROM media WHERE entity_type = ? AND entity_id = ? ORDER BY is_primary DESC, created_at DESC LIMIT 1`,
    [entityType, entityId]
  );
  return (result.rows[0] as unknown as MediaRecord) ?? null;
}
