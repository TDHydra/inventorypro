// #288: should the repair sheet open with its target locked?
//
// Pure so the invariant below is testable without the screen. The invariant that
// matters: NEVER lock without a target. Locking hides the picker AND disables the
// entity-type chips, so a lock with nothing selected would strand the user on a
// form they can't fill in and can't submit ("Choose what to repair." with no way
// to choose). Locking is therefore tied to an actual resolved target, not merely
// to the sheet having been opened from somewhere.

import type { Repair } from '../../repos/repairs';

/**
 * True when the sheet was opened FOR a specific thing — both a recognized entity
 * type AND an id. A caller that passes one without the other (or an entity type
 * this build doesn't know) gets the normal unlocked chooser.
 */
export function shouldLockTarget(
  entityType: Repair['entity_type'] | null,
  entityId: string | undefined | null,
): boolean {
  return !!entityType && typeof entityId === 'string' && entityId.trim().length > 0;
}
