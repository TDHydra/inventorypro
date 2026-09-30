/**
 * "Just added this session" types shared by QuickAddScreenShell and the quick-add
 * forms that support an inline edit/delete affordance (Item, Equipment unit,
 * Stock). Kinds not listed here (location, team, job, user, vehicle, repair)
 * simply don't get the affordance — their toast/counter keep working unchanged,
 * they just pass a plain `id` (or nothing) as before.
 */

/** What a quick-add form reports as its 3rd `onSaved` arg, alongside the existing
 * (label, createdId) pair, so the shell knows what kind of entity to build an
 * edit/delete affordance for. */
export type QuickAddSaveMeta =
  | { kind: 'item' }
  | { kind: 'equipment_unit' }
  | { kind: 'stock'; itemId: string; locationId: string; qty: number; mode: 'delta' | 'set'; unit: string };

/** Resolved reference the edit/delete sheet operates on — id merged in for the
 * kinds that only need one (item/equipment_unit already had it as `createdId`). */
export type JustAddedRef =
  | { kind: 'item'; id: string }
  | { kind: 'equipment_unit'; id: string }
  | { kind: 'stock'; itemId: string; locationId: string; qty: number; mode: 'delta' | 'set'; unit: string };
