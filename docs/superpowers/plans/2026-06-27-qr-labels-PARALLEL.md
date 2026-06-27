# QR Codes, Labels & Asset-Tag Scanning (P2 v1) — Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development / ultramode Workflow. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git / NO tsc; controller commits + tsc + reviews.

**Goal:** API-generated QR codes, printable QR labels (system print dialog), scan-to-open, and auto-generated asset tags.
**Architecture:** API renders QR PNGs encoding `INV:item:<id>` / `INV:unit:<assetTag>`; mobile composes an HTML label and prints via `expo-print`; a scan resolver parses the tokens; equipment create can auto-fill the next asset tag. No migration.
**Tech Stack:** Fastify + `qrcode`; Expo SDK 56 + `expo-print` (native), expo-camera.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. Deps already installed: api `qrcode`+`@types/qrcode`, mobile `expo-print` (~56.0.4, native → APK rebuild at ship).
- API QR endpoints use the existing `auth` preHandler. No migration, no new permission.
- QR payload tokens: `INV:item:<itemId>`, `INV:unit:<assetTag>`. tsc clean (mobile+api).
- **Full spec (the design + signatures): `docs/superpowers/specs/2026-06-27-qr-labels-design.md`** — ships with every brief.

---

# WAVE 0 (parallel, file-disjoint)

### Task 1: API QR generator
**Files:** Create `apps/api/src/routes/labels.ts`; Modify `apps/api/src/index.ts` (register under `/labels`).
- [ ] `labels.ts`: a `FastifyPluginAsync` with the `auth` preHandler (copy the pattern from `routes/items.ts`). `GET /item/:id/qr.png` → look up item (404 if missing) → `const buf = await QRCode.toBuffer('INV:item:'+id, { type:'png', width:512, margin:1 })` → `reply.type('image/png').send(buf)`. `GET /unit/:assetTag/qr.png` → validate the tag exists in `equipment_units` (404 else) → QR of `'INV:unit:'+assetTag`. Import `import QRCode from 'qrcode'`. Register in `index.ts` like the other routes with prefix `/labels`.
- [ ] **Controller:** `cd apps/api && npx tsc --noEmit` clean; commit `feat(api): /labels QR generator (qrcode)`.

### Task 2: Scan resolver
**Files:** Create `apps/mobile/src/scan/resolveScan.ts`; Modify `apps/mobile/app/(app)/(inventory)/scan.tsx`.
- [ ] `resolveScan(data): {kind:'item',id} | {kind:'unit',assetTag} | {kind:'barcode',code} | null` — `INV:item:`/`INV:unit:` prefixes else `{kind:'barcode',code:data}`. In `scan.tsx handleScanned`, call resolveScan then route: item → existing item open; unit → resolve the unit's item (add/use a `getUnitByAssetTag`-style query) and open `/(app)/(inventory)/[id]` for its item; barcode → existing `getItemByBarcode` path (keep "not found → add"). READ scan.tsx first.
- [ ] **Controller:** mobile tsc clean; commit `feat(scan): resolve INV: QR tokens to item/unit`.

### Task 3: Label print core (new files only)
**Files:** Create `apps/mobile/src/labels/printLabel.ts`, `apps/mobile/src/components/LabelPrintSheet.tsx`.
**Produces (consumed by Task 5):** `printLabel(opts:{title:string;code:string;qrUrl:string;template:LabelTemplate}):Promise<void>`; `type LabelTemplate='small'|'standard'|'large'`; `LabelPrintSheet({ visible, onClose, title, code, qrUrl })` component.
- [ ] `printLabel.ts`: `LABEL_TEMPLATES` map (small/standard/large → widthIn/heightIn/qrPx/fontPt). `printLabel` fetches the auth'd QR PNG (use `getValidJwt()` from `../auth/session`; download via `expo-file-system`/legacy `uploadAsync`-style or `fetch` with Bearer → base64 data URI), composes HTML (title + `<img src=dataUri>` + code at the template size), and calls `Print.printAsync({ html })` from `expo-print`. `LabelPrintSheet.tsx`: a `ModalSheet` with 3 `FilterChip` template options + a `PrimaryButton` "Print" calling `printLabel`. Use theme tokens.
- [ ] **Controller:** mobile tsc clean; commit `feat(labels): printLabel helper + LabelPrintSheet`.

### Task 4: Auto-generated asset tags
**Files:** Create `apps/mobile/src/db/queries/equipment.ts` (or extend items.ts) with `nextAssetTag(prefix:string):string`; Modify `apps/mobile/src/components/quickadd/EquipmentQuickAdd.tsx`.
**Produces (consumed by Task 5):** `nextAssetTag(prefix:string):string` → `prefix + String(maxExistingSuffix+1).padStart(3,'0')`.
- [ ] `nextAssetTag`: query `equipment_units` for `asset_tag LIKE prefix||'%'`, parse the trailing integer of each, return `prefix + pad(max+1)` (start at `001` if none). In `EquipmentQuickAdd`, when the selected item has a `tag_prefix` and the asset-tag field is empty, render a small "Generate" button that fills `nextAssetTag(prefix)`. Manual entry/scan unchanged.
- [ ] **Controller:** mobile tsc clean; commit `feat(equipment): auto-generate next asset tag`.

# WAVE 1 (after Tasks 3 & 4)

### Task 5: Wire into item/unit detail
**Files:** Modify `apps/mobile/app/(app)/(inventory)/[id].tsx`.
**Consumes:** `LabelPrintSheet` (T3), `nextAssetTag` (T4).
- [ ] Add a "🏷 Print QR Label" row on the item detail that opens `<LabelPrintSheet visible title={item.name} code={item.barcode ?? item.id} qrUrl={\`\${API}/labels/item/\${item.id}/qr.png\`} />`; add a per-unit "Print label" affordance using `/labels/unit/<assetTag>/qr.png`. In the unit-add flow here, offer the `nextAssetTag` generate (same as T4) when a tag_prefix exists and the field is blank. READ the file; reuse existing styles/primitives; change no unrelated logic. (`API` = `process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'`.)
- [ ] **Controller:** mobile tsc clean; commit `feat(inventory): print-QR-label + auto-tag in item/unit detail`.

# SHIP (controller)
- [ ] App-wide tsc (mobile+api) clean; whole-branch review (opus). Merge `feat/qr-labels` → `main`.
- [ ] **Deploy API** (new `/labels` route, additive, no migration) to prod. **Rebuild dev client + release APK** (expo-print is native). Verify: `GET /labels/item/<id>/qr.png` returns a PNG; scanning a printed QR opens the item.

## Self-Review
- Spec coverage: U1→T1; U2→T3+T5; U3→T2; U4→T4+T5. ✔
- File-collision: T1 api; T2 scan.tsx+resolveScan; T3 new label files; T4 equipment query+EquipmentQuickAdd; T5 [id].tsx (after T3,T4). Wave-0 disjoint; T5 alone in Wave 1 (owns [id].tsx). ✔
- Types: `printLabel`/`LabelPrintSheet`/`LabelTemplate` (T3) + `nextAssetTag` (T4) consumed by T5 verbatim. ✔
