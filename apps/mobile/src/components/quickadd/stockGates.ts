/**
 * Pure permission gates for quick-add stock writes, kept out of the components
 * so they can be unit-tested (node --test has no component renderer).
 *
 * The server's sync gates (apps/api/src/lib/syncPolicy.ts) are the source of
 * truth these mirror:
 *   - stock_by_location INSERT (a "set exact"/recount, or an item's starting
 *     stock) requires `checkin_inventory`;
 *   - stock_by_location ADJUST (delta add/remove/undo) requires checkin OR
 *     checkout;
 *   - inventory_items INSERT (the parent of a starting-stock row) requires
 *     `add_inventory`.
 * A client gate broader than the server's makes the save silently
 * Forbidden-dropped; a dropped PARENT additionally strands its dependent
 * stock INSERT as a server-side FK orphan.
 */

/** May a stock quick-add edit be saved? 'set' (recount) is a server-side INSERT
 * gated on checkin_inventory specifically; 'delta' is an ADJUST gated on the
 * broader checkin-or-checkout (canAdjustStock). */
export function canSaveStockEdit(
  mode: 'delta' | 'set',
  perms: { canAdjustStock: boolean; canRecount: boolean },
): boolean {
  if (!perms.canAdjustStock) return false;
  return mode !== 'set' || perms.canRecount;
}

/** May ItemQuickAdd offer/emit an optional starting-stock write? Requires the
 * parent item INSERT to land (add_inventory) AND the stock INSERT itself to
 * pass (checkin_inventory) — missing either turns the pair into a silent drop
 * or a permanently-orphaned stock row. */
export function canOfferStartingStock(
  perms: { canAddItems: boolean; canCheckinStock: boolean },
): boolean {
  return perms.canAddItems && perms.canCheckinStock;
}
