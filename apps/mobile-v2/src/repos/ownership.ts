// Shared owner/team membership check, extracted from repos/access.ts in
// Station D3 to break the require cycle locations → vehicles → access →
// locations (RN "can result in uninitialized values" warning): vehicles.ts
// needed access.ts ONLY for this one DB helper, which itself needs nothing
// from the repo layer. Keep this module free of repo imports.
import { getDb, rowsAs } from '../db/schema';

export function sharesTeamWithOwner(userId: string, ownerUserId: string | null): boolean {
  if (!ownerUserId) return false;
  if (ownerUserId === userId) return true;
  const db = getDb();
  return (rowsAs<{ n: number }>(db.executeSync(
    `SELECT COUNT(*) AS n FROM team_members a JOIN team_members b ON b.team_id = a.team_id
      WHERE a.user_id = ? AND b.user_id = ?`, [userId, ownerUserId],
  ).rows)[0]?.n ?? 0) > 0;
}
