// NOTE: getEquipmentModels/EquipmentModel (./equipment), searchJobs/Job
// (./jobs) and searchLocations/Location (./locations) are NOT ported yet —
// those are separate domain repos, out of scope for this items/search/
// suggestions port (see docs/REBUILD-PORTING.md's repo rules). Once those land
// at apps/mobile-v2/src/repos/{equipment,jobs,locations}.ts with matching
// exports, this file needs no changes — the imports already point at the
// right paths. Until then, `pnpm --filter mobile-v2 typecheck` will report
// "cannot find module" for these three imports; that failure belongs to the
// still-missing equipment/jobs/locations repos, not to this file.
import { searchItems, type ItemWithTotalStock } from './items';
import { getEquipmentModels, type EquipmentModel } from './equipment';
import { searchJobs } from './jobs';
import type { Job } from './jobs';
import { searchLocations } from './locations';
import type { Location } from './locations';
import { searchUsers } from './users';
import type { User } from './users';

export interface GlobalSearchResults {
  items: ItemWithTotalStock[];
  equipment: EquipmentModel[];
  locations: Location[];
  jobs: Job[];
  users: User[];
}

// One query across every entity, grouped by type. `items` is products only
// (kind='product'); equipment lives in its own group. Empty query → all empty.
export function searchEverything(q: string, perGroup = 10): GlobalSearchResults {
  const query = q.trim();
  if (query.length < 1) {
    return { items: [], equipment: [], locations: [], jobs: [], users: [] };
  }
  return {
    items: searchItems(query, perGroup, 0, undefined, 'product'),
    equipment: getEquipmentModels(query).slice(0, perGroup),
    locations: searchLocations(query, perGroup),
    jobs: searchJobs(query).slice(0, perGroup),
    users: searchUsers(query, perGroup),
  };
}
