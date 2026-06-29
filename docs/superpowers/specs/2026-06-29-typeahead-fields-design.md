# Spec: Filter-as-you-type fields + approval-gated cross-fill

*Date: 2026-06-29*

## Context

Several recurring free-text fields force employees to retype the same values across
records (supplier, model/color, category on catalog/equipment; customer name,
insurance carrier, site address on jobs). Three already show suggestion *chips*
(`SuggestInput`) but no real dropdown; three are plain text with no filtering at all.
Entity-reference fields (locations, items, jobs, owners, …) already use the
`SearchablePicker` typeahead — this work brings the remaining free-text *value* fields
up to the same "type to filter, tap to pick" experience, and adds an approval-gated
cross-fill so picking a known customer can offer to fill their usual job details.

## Goals

1. Every recurring free-text field is a filter-as-you-type dropdown of prior values.
2. Picking an existing **customer** offers (with employee confirmation) to fill that
   customer's last-job address, carrier, and site location.
3. No schema/migration changes — all sources are reads over existing columns.

## Non-goals

- Genuinely unique/free-form fields stay plain text: item/job/team/user/location/
  vehicle **names**, descriptions/notes, SKU / asset tag / serial / reference # (unique
  IDs), and numeric fields (qty, pack size, thresholds).
- No cross-fill for supplier/model/category (standalone values, nothing related).
- No restructuring of the category↔taxonomy duality (only the free-text `category`
  column gets the dropdown).

## Design

### 1. Reusable dropdown for free-text values (`SuggestInput` upgrade)

These columns store plain strings, not entity ids, so the pill-style `SearchablePicker`
is the wrong fit. Instead, upgrade the existing `src/components/SuggestInput.tsx` from
"chips under a text box" into a real typeahead: a text field that drops down a live,
case-insensitively filtered list of prior values as you type; tap a row to fill it, or
keep typing a brand-new value (for free-text columns, typing the new value **is** the
"create" — no separate row). Keep its current string API so the three existing usages
upgrade in place.

Props (string-based, backward compatible):
- `value: string`, `onChange: (v: string) => void`, `suggestions: string[]`
- `placeholder?`, `label?`, `autoCapitalize?`
- NEW `onPick?: (v: string) => void` — fired only on explicit selection of an existing
  row (not on every keystroke), used to trigger cross-fill. `onChange` still fires for
  the value update.
- Reuse the dropdown row styling from `SearchablePicker` for a consistent look; cap the
  list (~8 rows); dropdown closes on blur/select.

### 2. Fields converted (8 spots, 4 screens)

Already `SuggestInput` → get the upgrade automatically (source: existing
`getDistinctValues()` in `src/db/queries/items.ts`):
- **Supplier** — `inventory/add.tsx`, `inventory/[id].tsx`, `equipment/[id].tsx`
- **Model/Color** — same three
- **Category** — `inventory/[id].tsx`, `equipment/[id].tsx`

Plain `AppInput` → swap to the dropdown (source: new `jobs.ts` queries):
- **Customer name**, **Insurance carrier**, **Site address** — `jobs/create.tsx` and
  `src/components/quickadd/JobQuickAdd.tsx`

### 3. New read queries (`src/db/queries/jobs.ts`)

- `getDistinctCustomerNames(): string[]`
- `getDistinctInsuranceCarriers(): string[]`
- `getDistinctSiteAddresses(): string[]`
  (all: `SELECT DISTINCT <col> … WHERE col IS NOT NULL AND TRIM(col) != '' ORDER BY col
  COLLATE NOCASE`, mirroring `getDistinctValues`)
- `getLatestJobByCustomer(name): { site_address, insurance_carrier, site_location_id,
  site_location_label } | null` — most recent job for that customer (case-insensitive),
  for cross-fill.

### 4. Approval-gated cross-fill (Customer → address + carrier + site location)

In the job forms, when the customer field's `onPick` fires (employee tapped an existing
customer) and `getLatestJobByCustomer` returns details, and the related fields are
currently empty, show a themed confirm (`themedAlert`/confirm):

> **Use {Customer}'s details from their last job?**
> Address: {site_address} · Carrier: {insurance_carrier}
> [ Fill them in ] [ Skip ]

On confirm, set Site address, Insurance carrier, and Site location (only fields that are
empty and have a value to copy). Nothing is filled without that tap. Free typing of a new
customer never triggers the prompt.

## Data flow

field keystroke → `onChange` updates string state → dropdown filters `suggestions`
client-side → tap row → `onChange` + `onPick(value)` → (customer only) cross-fill lookup
→ themed confirm → conditional set of related fields.

## Testing / verification

- `npx tsc --noEmit` clean (mobile).
- Build dev-client APK + hotload via Metro (deploy-android §B).
- On device: each converted field shows a filtering dropdown of prior values and accepts
  new typed values; picking a known customer prompts and, on confirm, fills address +
  carrier + site location; "Skip" leaves fields untouched; typing a new customer shows
  no prompt.

## Files

- `src/components/SuggestInput.tsx` — dropdown upgrade + `onPick`
- `src/db/queries/jobs.ts` — 3 distinct-value queries + `getLatestJobByCustomer`
- `app/(app)/(inventory)/add.tsx`, `app/(app)/(inventory)/[id].tsx`,
  `app/(app)/(equipment)/[id].tsx` — supplier/model/category (mostly free via upgrade)
- `app/(app)/(jobs)/create.tsx`, `src/components/quickadd/JobQuickAdd.tsx` —
  customer/carrier/address swaps + cross-fill wiring
