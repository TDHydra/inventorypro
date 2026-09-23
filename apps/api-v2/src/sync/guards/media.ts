import { validateMediaWrite } from '../../lib/syncPolicy';
import { cleanupMediaObjects } from '../../lib/mediaCleanup';
import { deliver, resolvePoolRecipients } from '../../lib/notifications';
import type { TableGuard } from '../types';

// media: entity-linkage guard (pure rules in syncPolicy.validateMediaWrite).
// INSERT must attach to an allowlisted entity type (the REST upload path
// always enforced this; the sync path didn't). UPDATE may re-link (the
// "move" feature) only to a job — and the target job must actually exist.
// DELETE pre-captures the row so the MinIO object cleanup after a successful
// delete has the url/thumbnail to work from.
export const mediaGuard: TableGuard = {
  table: 'media',
  async authorizeRow(ctx, entry) {
    if (entry.operation === 'INSERT' || entry.operation === 'UPDATE') {
      const mediaErr = validateMediaWrite(entry.operation, entry.payload);
      if (mediaErr) {
        ctx.log.warn({ userId: ctx.userId, operation: entry.operation }, 'sync push media write denied (entity linkage)');
        return { error: `Forbidden: ${mediaErr}`, code: 'VALIDATION' };
      }
      if (entry.operation === 'UPDATE' && entry.payload.entity_id !== undefined) {
        const { rows: jobRows } = await ctx.pg.query(
          `SELECT 1 FROM jobs WHERE id = $1`, [entry.payload.entity_id],
        );
        if (!jobRows[0]) {
          return { error: 'Forbidden: target job does not exist', code: 'VALIDATION' };
        }
      }
    }
    if (entry.operation === 'DELETE') {
      const { rows: mediaRows } = await ctx.pg.query(
        `SELECT id, url, thumbnail_url FROM media WHERE id = $1`, [entry.payload.id],
      );
      const row = mediaRows[0] as { id: string; url: string; thumbnail_url: string | null } | undefined;
      if (row) ctx.batch.mediaCleanup.set(entry.id, row);
    }
    return undefined;
  },
  async afterApply(ctx, entry) {
    // Media row deleted → best-effort MinIO object cleanup (shared with the
    // REST route; move-tolerant + table-wide refcount). Fire-and-forget:
    // never blocks or fails the sync write — a failed cleanup only leaves
    // an orphaned object, never data loss.
    const cleanupRow = ctx.batch.mediaCleanup.get(entry.id);
    if (cleanupRow) {
      void cleanupMediaObjects(ctx.pg, cleanupRow).catch(err =>
        ctx.log.warn({ mediaId: cleanupRow.id, err: (err as Error).message }, 'media object cleanup failed'),
      );
    }
    // #87: pool photo share → notify the audience. users/team push+inbox;
    // 'everyone' inbox-only for ALL active users (no company-wide push
    // blast). Fire-and-forget: never blocks or fails the sync write.
    if (entry.operation === 'INSERT' && entry.payload.entity_type === 'pool') {
      const { pg, userId, shareEmailSender } = ctx;
      const aud = String(entry.payload.audience ?? '');
      const mediaId = String(entry.payload.id ?? '');
      const note = typeof entry.payload.location_note === 'string' && entry.payload.location_note.trim()
        ? entry.payload.location_note.trim() : null;
      const audienceUserIds = entry.payload.audience_user_ids;
      void (async () => {
        try {
          let recipients: string[];
          let push = true;
          if (aud === 'everyone') {
            recipients = (await pg.query(
              `SELECT id FROM users WHERE active = TRUE AND id != $1`, [userId],
            )).rows.map(r => (r as { id: string }).id);
            push = false;
          } else if (aud === 'team' || aud === 'users') {
            recipients = await resolvePoolRecipients(pg, aud, audienceUserIds, userId);
          } else return;
          if (!recipients.length || !mediaId) return;
          const { rows: uRows } = await pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
          const senderName = uRows[0] ? String((uRows[0] as { name: string }).name) : 'Photo shared';
          await deliver(pg, recipients, {
            type: 'media_share',
            title: senderName,
            body: note ? `Shared a photo — ${note}` : 'Shared a photo',
            data: { screen: 'media', id: mediaId },
            createdBy: userId,
            push,
          });
          // #171 email leg: provider-agnostic stub, dormant unless
          // MEDIA_SHARE_EMAIL=1 (default OFF). 'everyone' never emails —
          // mirrors the quiet-push rule just above (push=false for that
          // audience). Fire-and-forget per recipient.
          if (process.env.MEDIA_SHARE_EMAIL === '1' && aud !== 'everyone') {
            const { rows: emailRows } = await pg.query(
              `SELECT email FROM users WHERE id = ANY($1) AND email IS NOT NULL`,
              [recipients],
            );
            for (const row of emailRows as { email: string }[]) {
              void shareEmailSender
                .sendMediaShareEmail({ to: row.email, senderName, note, mediaId })
                .catch(() => { /* never disrupt sync */ });
            }
          }
        } catch { /* never disrupt sync */ }
      })();
    }
  },
};
