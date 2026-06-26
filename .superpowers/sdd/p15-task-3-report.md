# Task 3 Report — To-Job honors `returnable`

## What changed

**File:** `apps/mobile/app/(app)/(checkout)/index.tsx`

### 1. Returnable lookup + action branch (in `handleConfirm`, `destType === 'job'` path)

After the three guard checks (job selected, qty positive, qty ≤ on-hand) and before
`setSubmitting(true)`, added:

```ts
const returnable = !!getItemById(itemId)?.returnable;
const logAction = returnable ? 'checkout_to_job' : 'consumed';
```

`appendLog` now uses `logAction` instead of the hard-coded `'checkout_to_job'` string.
The `done()` message also branches: "checked out to …" vs "consumed for …".

### 2. Stock writes — unchanged

`stockMove(itemId, source, null, qty)` is called identically in both cases:
- `adjustStock(itemId, source, -qty)` deducts source stock.
- `appendOutbox('INSERT', 'stock_by_location', { …absolute qty… })` is written once for
  the source location.
- `toLoc` is `null` in both cases (no destination stock credit for job checkout or consume).

Signs and the absolute-qty outbox pattern are not altered.

### 3. Location and PM paths — unchanged

The `destType === 'location'` and `destType === 'pm'` branches are untouched.
Both still log `action: 'transfer'` and call `stockMove` with a real `toLoc`.

### 4. Confirm-screen label (optional polish)

Added an "Action" `<Row>` in the Job section of the confirm card:

- Returnable item → **Deploy (returnable)**
- Non-returnable item → **Consume**

Uses `selectedItem.returnable` directly (the `ItemWithTotalStock` returned by
`searchItems` already carries all `InventoryItem` columns including `returnable`),
so no extra DB call at render time.

## TypeScript result

`cd apps/mobile && npx tsc --noEmit -p tsconfig.json` → **exit 0, no errors**.

## On-device verification

Pending — needs a physical device with the Expo dev-client build.
Manual test plan:
1. Add a non-returnable item (returnable=0) and a returnable item (returnable=1).
2. Check both out To Job.
3. Confirm non-returnable shows "Consume" / "Action: Consume" on the review card.
4. Confirm returnable shows "Deploy (returnable)" / "Action: Deploy (returnable)".
5. After confirming, open Check In — only the returnable item should appear in outstanding checkouts.
6. Verify the non-returnable item's activity_log row has action='consumed', not 'checkout_to_job'.
