# Data patterns — reactive reads, writes, validation

## Reads: `useDbQuery(fn, deps, tables)`

```ts
const rows = useDbQuery(
  () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
  [visible],            // ordinary reactive deps
  ['jobs'],             // DB tables whose writes should re-run fn
);
```

- Re-runs on local writes AND background sync pulls touching the listed
  tables (#60/#63). List every table `fn` reads, including join lookups.
- **Do NOT convert snapshot-on-open edit forms** — a form seeded from the DB
  when the sheet opens must not re-read mid-edit (it would clobber the user's
  typing). Seed in the `visible`-effect instead. Same for drag-reorder
  screens mid-drag. This principled skip list is the #163 lesson.
- Gate on `visible` inside `fn` (`if (!visible) return []`) so hidden sheets
  don't pay query cost.

## Writes: upsert + outbox, in a transaction

```ts
const now = new Date().toISOString();
runInTransaction(() => {
  const updated = { ...row, name: newName, updated_at: now, synced_at: null };
  upsertThing(updated);
  const { synced_at: _sa, ...serverRow } = updated;   // strip device-local col
  appendOutbox('UPDATE', 'things', serverRow);
  appendLog({ ... });                                  // when the house logs it
});
```

- `synced_at` is device-local only — the server rejects rows that include it.
  Always strip before `appendOutbox`.
- Absolute stock sets push as `INSERT` (server upserts via ON CONFLICT), not
  `UPDATE`; deltas use `ADJUST`.
- **Nested-transaction trap**: some query helpers open their OWN transaction
  (e.g. `createServiceRecord`) — never call them inside another
  `runInTransaction`. Check the helper before nesting.
- Gate every write path with `isWriteBlocked()` (maintenance mode) and the
  matching `usePermission` in the UI.

## Validation — `src/lib/validation.ts` only

`validateName`, `validateText`, `parseQuantity`, `parseOptionalCount`,
`parseOptionalNonNegative`, `parseOptionalDate`, `validateEmail`,
`validatePhone`, `validateBarcode`, `isUuid`. All return result objects
(`{ok, value} | {ok:false, error, rule}`); on reject, fire the telemetry
`validation_reject` audit (see logging.md) and show a themed Alert. Never
ad-hoc `parseFloat`/regex in a form.

## Migrations & synced columns

Adding a synced table/column is NEVER just a migration. Follow
`docs/SYNC-MIGRATION-CHECKLIST.md` end-to-end: API migration + mobile
migration registered in BOTH `schema.ts` AND `schema.web.ts`, `pull.ts`
upsert SQL + rowToValues parity (column count == placeholder count), push
`ALLOWED_TABLES`/`selectColumnsFor`/write-policy, and API-before-mobile
deploy lockstep. A miss silently drops the column with no error.

Postgres ENUM columns are TEXT on mobile SQLite — never remap enum values in
a migration without ALTERing prod to TEXT first. Migration-seeded rows need
`updated_at = NOW()` or already-enrolled devices never pull them.
