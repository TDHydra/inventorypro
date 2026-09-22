import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSaveStockEdit, canOfferStartingStock } from './stockGates';

// Mirrors the server's syncPolicy gates: stock_by_location INSERT (recount /
// starting stock) needs checkin_inventory; ADJUST needs checkin OR checkout;
// the parent inventory_items INSERT needs add_inventory. A client gate looser
// than the server's turns saves into silent Forbidden drops — and a dropped
// parent item strands its starting-stock INSERT as a server-side FK orphan.

test('canSaveStockEdit: delta edits need only the broad adjust perm (checkin OR checkout)', () => {
  assert.equal(canSaveStockEdit('delta', { canAdjustStock: true, canRecount: false }), true);
  assert.equal(canSaveStockEdit('delta', { canAdjustStock: true, canRecount: true }), true);
  assert.equal(canSaveStockEdit('delta', { canAdjustStock: false, canRecount: false }), false);
});

test('canSaveStockEdit: set (recount) edits additionally need checkin_inventory', () => {
  // The regression: a checkout-only role passes canAdjustStock, but the server
  // Forbidden-drops the recount INSERT — the client must not offer the save.
  assert.equal(canSaveStockEdit('set', { canAdjustStock: true, canRecount: false }), false);
  assert.equal(canSaveStockEdit('set', { canAdjustStock: true, canRecount: true }), true);
  assert.equal(canSaveStockEdit('set', { canAdjustStock: false, canRecount: true }), false);
});

test('canOfferStartingStock: requires BOTH the parent-item and the stock INSERT to be landable', () => {
  assert.equal(canOfferStartingStock({ canAddItems: true, canCheckinStock: true }), true);
  // No add_inventory → the parent item push is rejected, so a starting-stock
  // row would FK-orphan server-side (the infinite-retry bug).
  assert.equal(canOfferStartingStock({ canAddItems: false, canCheckinStock: true }), false);
  // No checkin_inventory → the stock INSERT itself is silently dropped.
  assert.equal(canOfferStartingStock({ canAddItems: true, canCheckinStock: false }), false);
  assert.equal(canOfferStartingStock({ canAddItems: false, canCheckinStock: false }), false);
});
