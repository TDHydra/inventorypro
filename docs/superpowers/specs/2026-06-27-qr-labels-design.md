# QR Codes, Labels & Asset-Tag Scanning (P2 v1) — Design Spec

*Date: 2026-06-27 · Branch: `feat/qr-labels` · Roadmap program P2 (first).*

## Context

Restoration crews need to put **scannable QR labels** on products/equipment and scan them back to
open the item, plus stop hand-typing asset tags. This is P2 v1 from the backlog roadmap:
QR generation (API), printable labels, asset-tag camera scan, and auto-generated asset tags.

### Autonomous v1 decisions (assumptions — adjust freely)
The user delegated this build ("proceed"). Decisions made, flagged so they can be changed later:
- **QR payload format:** app-generated QR encodes a token `INV:item:<itemId>` (products) or
  `INV:unit:<assetTag>` (tracked equipment units). The scan resolver also still honors raw UPC/EAN
  barcodes (existing behavior). This makes every item scannable even without a UPC.
- **QR generation lives on the API** (as the user explicitly asked): `GET /items/:id/qr` etc. render a
  PNG via the `qrcode` lib. (Printing is an online office/warehouse task, so an API fetch is acceptable;
  a future offline client-side QR is a follow-up.)
- **Printing uses `expo-print`'s system dialog** (`Print.printAsync({ html })`) — the OS print sheet
  supports AirPrint / network / most label printers, so v1 is **printer-agnostic** (no hardware lock-in).
- **Label "templates" = 3 size presets** (Small thermal ~2.25×1.25in / Standard / Large) that adjust the
  printed HTML's dimensions. Richer per-printer templates are a v2 follow-up.

## Global Constraints
- Expo SDK 56 (`https://docs.expo.dev/versions/v56.0.0/`); op-sqlite bind params only `string|number|null|ArrayBuffer`.
- **New deps (controller installs before build):** API `qrcode` + `@types/qrcode`; mobile `expo-print`
  (**native** → dev-client + release-APK rebuild at ship; no migration).
- No DB migration, no new permission. Reuse `ui/*` primitives + `theme.ts`.
- API routes are JWT-protected via the existing `auth` preHandler; QR endpoints follow that.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api).

## Shared Context Pack
- **Scanner:** `src/components/BarcodeScanner.tsx` (`{ active, onScanned(data:string), onClose }`, already
  reads `qr`). `src/components/BarcodeInput.tsx` = text field + inline Scan button (wraps BarcodeScanner).
- **Scan resolution today:** `app/(app)/(inventory)/scan.tsx` `handleScanned(code)` → `getItemByBarcode(code)`
  → checkout, else prompt to add. Queries: `getItemByBarcode`, `getItemById` (`src/db/queries/items.ts`);
  equipment by asset tag — add `getUnitByAssetTag` if absent (check `src/db/queries/equipment*` / items).
- **API:** `apps/api/src/routes/items.ts` has `GET /items/:id`, `/items/barcode/:code`; `auth` preHandler
  pattern in-file. Registered under `/items` prefix (check `index.ts`). Equipment units are synced but may
  lack a dedicated route — add QR endpoints where they fit (items.ts or a new `labels.ts`).
- **Equipment create:** `src/components/quickadd/EquipmentQuickAdd.tsx` (`assetTag` state, `tag_prefix`,
  `asset_tag` on insert) and `app/(app)/(inventory)/[id].tsx` (unit add/edit; `tag_prefix`).
- **Item/unit detail:** `app/(app)/(inventory)/[id].tsx` (item detail + registered units list) — the natural
  home for a "Print QR Label" action.

---

## Architecture (4 units)

### Unit 1 — API QR generator
`apps/api/src/routes/labels.ts` (new, registered under `/labels` in `index.ts`; `auth` preHandler):
- `GET /labels/item/:id/qr.png` → 200 `image/png`: look up the item; render a QR encoding `INV:item:<id>`
  via `qrcode` (`QRCode.toBuffer(payload, { type:'png', width:512, margin:1 })`); 404 if item missing.
- `GET /labels/unit/:assetTag/qr.png` → QR encoding `INV:unit:<assetTag>` (validate the tag exists in
  `equipment_units`; 404 if not).
- (Optional, same file) `GET /labels/item/:id/qr.svg` → `image/svg+xml` for crisp print scaling.
The PNG/SVG is the "QR generator" any integration or the app can use.

### Unit 2 — Mobile label preview + print (`src/components/LabelPrint.tsx` + a `printLabel` helper)
- `src/labels/printLabel.ts`: `printLabel(opts: { title: string; code: string; qrUrl: string; template: LabelTemplate }): Promise<void>`
  — composes an HTML label (title + `<img src=qrUrl>` + code, sized per template) and calls
  `Print.printAsync({ html })` (from `expo-print`). `type LabelTemplate = 'small'|'standard'|'large'` with a
  `LABEL_TEMPLATES` map → `{ widthIn, heightIn, qrPx, fontPt }`.
- `qrUrl` = `${EXPO_PUBLIC_API_URL}/labels/item/${id}/qr.png` (or `/labels/unit/${assetTag}/qr.png`) with the
  JWT — since the endpoint is auth'd, the helper fetches the PNG with the Bearer token via
  `expo-file-system` download (or fetch→blob→data-URI) and embeds it as a data URI in the HTML (so the
  print HTML needs no auth). Reuse the `getValidJwt()` session helper.
- UI: a `LabelPrintSheet` (uses `ModalSheet`) with the template selector (3 `FilterChip`s) + a "Print"
  `PrimaryButton`. Opened from a "🏷 Print QR Label" row on the item detail and on each registered unit.

### Unit 3 — Scan resolver (`src/scan/resolveScan.ts`) + wire-in
- `resolveScan(data: string): { kind:'item'; id:string } | { kind:'unit'; assetTag:string } | { kind:'barcode'; code:string } | null`
  — parse: `INV:item:<id>` → item; `INV:unit:<tag>` → unit; else treat as a raw barcode (`{kind:'barcode',code:data}`).
- Wire into `scan.tsx handleScanned`: resolve, then navigate — item → existing item flow; unit → resolve the
  unit's item and open its detail; barcode → existing `getItemByBarcode`. Keeps the "not found → add" path.

### Unit 4 — Auto-generated asset tags
- `src/db/queries/equipment.ts` (or items.ts) add `nextAssetTag(prefix: string): string` — finds existing
  `equipment_units.asset_tag` starting with `prefix`, parses the max trailing integer, returns
  `prefix + String(max+1).padStart(3,'0')` (e.g. `AM-001`). Pure local query.
- In `EquipmentQuickAdd` (and `[id].tsx` unit add): when the item has a `tag_prefix` and the asset-tag field
  is empty, show a "Generate" affordance (or pre-fill) that fills `nextAssetTag(prefix)`. Manual entry/scan
  still wins.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/routes/labels.ts` (new), `apps/api/src/index.ts` (register), api deps `qrcode`+`@types/qrcode` |
| 2 | `apps/mobile/src/labels/printLabel.ts` (new), `apps/mobile/src/components/LabelPrintSheet.tsx` (new), `app/(app)/(inventory)/[id].tsx` (add "Print QR Label" rows), mobile dep `expo-print` |
| 3 | `apps/mobile/src/scan/resolveScan.ts` (new), `app/(app)/(inventory)/scan.tsx` |
| 4 | `apps/mobile/src/db/queries/equipment.ts` or `items.ts` (`nextAssetTag`), `EquipmentQuickAdd.tsx`, `app/(app)/(inventory)/[id].tsx` |

## Verification
- `tsc --noEmit` clean (mobile + api).
- API: `GET /labels/item/<id>/qr.png` with a valid JWT returns a 200 PNG that decodes to `INV:item:<id>`.
- Mobile: item detail "Print QR Label" → template sheet → system print dialog shows a label (title + QR + code).
- Scan a printed `INV:item` QR → opens the right item; `INV:unit` → opens the unit's item; a raw UPC still resolves.
- Equipment create with a `tag_prefix` and blank asset tag → "Generate" fills `<prefix><nnn>`, incrementing.

## Out of scope (v2)
- Per-printer/per-label-stock templates (DYMO/Zebra layouts), batch label printing, offline client-side QR
  generation, label-design editor, barcode (non-QR) label formats. Encryption/signing of QR payloads.
