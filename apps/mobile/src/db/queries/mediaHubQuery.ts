// Pure SQL builder for the media hub browse — NO db imports so it runs under
// node --test (importing ./media pulls getDb → native op-sqlite; same split as
// components/pickers/resolveTaxonomyValue).
//
// Every media metadata row is already on-device (the org-wide sync pulls the
// whole table), so the hub browses local SQLite; no server endpoint involved.
//   open       → job media for OPEN jobs only (the default working set)
//   all        → job media regardless of job status
//   everything → every entity's media (items, equipment, repairs, …) — the
//                caller gates this behind view_all_logs
//   shared     → #87/#148: pool-shared photos (entity_type='pool'). NOT gated
//                behind view_all_logs — a device only ever holds the pool rows
//                the server's mediaScopeSql already decided this user may see
//                (uploader/team/everyone/listed-user), so it's personal inbox
//                content, not an org-wide browse like 'everything'.
// Search is a LIKE over job name, location note, caption, and uploader name.

export type MediaHubFilter = 'open' | 'all' | 'everything' | 'shared';

export function buildMediaHubQuery(
  filter: MediaHubFilter,
  search: string,
  limit: number,
  offset: number,
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter === 'open') {
    where.push(`m.entity_type = 'job'`, `j.status = 'open'`);
  } else if (filter === 'all') {
    where.push(`m.entity_type = 'job'`);
  } else if (filter === 'shared') {
    where.push(`m.entity_type = 'pool'`);
  }
  const q = search.trim();
  if (q) {
    where.push(`(j.name LIKE ? OR m.location_note LIKE ? OR m.caption LIKE ? OR u.name LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const sql =
    `SELECT m.*, j.name AS job_name, j.status AS job_status, u.name AS uploader_name
     FROM media m
     LEFT JOIN jobs j ON m.entity_type = 'job' AND j.id = m.entity_id
     LEFT JOIN users u ON u.id = m.uploaded_by` +
    (where.length ? `\n     WHERE ${where.join(' AND ')}` : '') +
    `\n     ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return { sql, params };
}
