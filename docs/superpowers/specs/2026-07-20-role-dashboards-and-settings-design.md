# Role Dashboards + Role-Aware Settings — Design

Date: 2026-07-20 · Branch: `feature/role-dashboards` · Status: approved in-session

## Goal

Give every one of the 13 roles a tailored dashboard (live data widgets + curated action tiles) and a role-aware Settings page with a self-service **My Profile** section (PIN / email / phone). Built one role at a time with live hotload review; foundation first.

## Non-goals

- No SMS verification for phone (no SMS infra) — format validation only.
- No forked checkout/check-in flows — dashboards only link into the existing shared flows.
- No changes to the admin preset editor's core model (presets still override code defaults).

## 1. Dashboard architecture

Existing engine: `apps/mobile/src/dashboard/` (`widgets.ts` registry, `store.ts` reactive presets, `resolve.ts`), rendered by `apps/mobile/app/(app)/(dashboard)/index.tsx`.

Changes:

- **`ROLE_DEFAULT_LAYOUTS: Partial<Record<UserRole, Layout>>`** in `src/dashboard/widgets.ts` (or a sibling `roleLayouts.ts`). Resolution order in `resolveLayoutFor(user)` becomes: **user preset → role preset (DB) → `ROLE_DEFAULT_LAYOUTS[user.role]` → `DEFAULT_LAYOUT`**.
- **Layout blocks gain an optional `config` payload** (typed per widget) so one widget type renders different content (query source, title, tap-through route). `parsePresetLayout` must tolerate unknown widgets/configs (forward compat).
- **Pinned search:** `DashboardSearch` (which includes the 📷 scan button → `/(app)/(hub)?scan=1`) is ALWAYS rendered at the top of the dashboard screen, outside the resolved layout. Remove `'search'` from layouts/registry-pickable widgets (keep parsing tolerant of old presets containing it — just skip it since it's now pinned).
- New widget types registered in `WIDGET_REGISTRY` with `requiredPermission` where applicable so they appear in the admin preset editor and stay permission-gated.

## 2. Widget kit (generic + configurable; no migrations, existing local queries only)

All built from the UI kit (`Card`, `KeyValueRow`, `StatusBadge`, `EmptyState`, …), theme tokens only (no hex), JS-only/web-safe per `src/components/ui/README.md`, data via `useReactiveRows` / `useTableVersion`.

- **StatTiles** — row of 2–4 tappable count cards. Config: array of stat sources. Sources (existing queries in `src/db/queries/`): my active checkouts, open repairs (`getRepairs({done:false})`), units due service (`getUnitsDueForService`), low-stock count (`getLowStockItems`), open jobs, team member count.
- **WorkList** — compact card list (title, up to N rows, "view all" tap-through). Sources: my checked-out equipment, open jobs, open repairs, units due service, low-stock items.
- **ActivityPreview** — last N activity-log entries (reuse `ActivityFeed` internals / `db/queries/log.ts`), honoring existing log-view permissions.
- Reused as-is: Fast Checkout / Fast Check-In tiles, nav tiles, contextual quick actions (`quickActions.ts`), OnCall widget, QuickAddBanner.

Empty data → `EmptyState`, never a blank card. All widgets update after sync via the data-version subscription.

## 3. Per-role starter layouts (refined live, role by role)

Rollout order (crew-first): mitigation_technician → contents_crew → construction_crew → carpet_cleaning_crew → temporary_employee → production_manager → head_of_contents → head_of_construction → carpet_cleaning_manager → office_manager → hr_manager → franchise_manager → full_admin.

Starters (all have pinned search on top; permission gates still apply):

| Role group | Starter layout |
|---|---|
| Crew (mitigation_technician, contents_crew, construction_crew, carpet_cleaning_crew) | Fast Checkout + Fast Check-In (half/half), StatTiles [my checkouts, units due service], WorkList "My equipment", quick actions, OnCall, nav tiles relevant to the role (jobs, vehicles, lockers) |
| temporary_employee | Fast Checkout + Fast Check-In, WorkList "My equipment" only |
| Tier-2 managers (production_manager, head_of_construction, head_of_contents, carpet_cleaning_manager) | Fast tiles, StatTiles [open jobs, open repairs, low stock, due service], WorkList "Open jobs", low-stock list, ActivityPreview, team/jobs/inventory nav tiles |
| office_manager | StatTiles [open jobs, low stock], WorkList "Open jobs", ActivityPreview, jobs/inventory/locations/logs nav tiles |
| hr_manager | StatTiles [team members], ActivityPreview, users/teams/logs nav tiles |
| franchise_manager, full_admin | StatTiles [open jobs, low stock, open repairs, due service], ActivityPreview, quick actions, WorkList "Open jobs", admin nav tiles |

These are starting points — each role gets a live on-device review and one-line config tweaks.

## 4. Settings: role-aware page + My Profile

`apps/mobile/app/(app)/(admin)/settings.tsx` (renders for everyone) is restructured into role/permission-driven sections. All roles keep: Theme picker, App Info (version), Logout.

**New: My Profile (all roles):**

- **Change PIN:** enter current PIN → new PIN twice. Client validation reuses enrollment rules: `validatePinFormat(pin, user.pin_length_required)`, `isWeakPin` + `COMMON_PINS` (`src/auth/pin.ts`). Server re-validates and rejects new == current. PIN never stored on device (online-only, as today).
- **Change email:** `validateEmail` (`src/lib/validation.ts`) → request 6-digit code emailed to the NEW address → enter code → saved. If SMTP unconfigured (`{sent:false}`), fall back to type-twice confirm.
- **Change phone:** new nullable `users.phone`. Client+server validation: optional leading `+`, 7–15 digits after stripping separators/spaces; stored normalized.

**Role-gated entries (existing, kept as today; adjustable per role in live sessions):** Dashboard editor + Label Designer (tier 4), Notification Routing (`system_settings`), Broadcast (`send_notifications`), notification trigger config + org theme + other admin sections (unchanged gates).

Which sections each role sees is reviewed role by role alongside its dashboard (one login per role covers both).

## 5. API additions (`apps/api`)

All authenticated, rate-limited like existing auth routes; server-side validation mirrors client.

- `POST /me/change-pin` `{currentPin, newPin}` → 204. Errors: invalid current PIN (403), format/length (from `users.pin_length_required`), weak (`lib/weakPin.ts`), same-as-current (bcrypt compare).
- `POST /me/email/request-code` `{email}` → `{sent: boolean}`. Stores pending change (small table `user_email_changes`: user_id PK, email, code_hash nullable, expires_at ~10 min) and sends 6-digit code via `lib/mail.ts`. SMTP unconfigured → store pending with null code_hash, return `{sent:false}`.
- `POST /me/email/confirm` `{email, code?}` → 204. Requires matching unexpired pending row; code must match its hash, EXCEPT when code_hash is null (SMTP-unavailable fallback). Sets `users.email`, bumps `updated_at` (propagates via sync), clears pending.
- `PUT /me/phone` `{phone: string|null}` → 204. Validates + normalizes; bumps `updated_at`.

**Migrations:**

- API: add `users.phone TEXT` (nullable) + `user_email_changes` table.
- Mobile: add `phone` to local `users` — migration added to **BOTH** `schema.ts` and `schema.web.ts` import arrays (known web trap).
- Sync: ensure `phone` flows through pull/full-download payloads and mobile row-apply for `users`. Column-add only → no seed-watermark risk.

## 6. Testing

- Unit tests: layout resolution order (user preset > role preset > role default > default), preset parsing tolerance (old `'search'` blocks, unknown widgets), phone/email validators, API endpoint tests (change-pin validation matrix incl. same-as-current + weak + wrong length; email code expiry/mismatch/SMTP-fallback; phone normalization).
- Widgets render with empty DB (EmptyState) — no crashes on fresh device.
- Web parity: JS-only widgets; both schema files carry the migration.

## 7. Delivery

1. **Foundation** (this branch, multi-agent build): everything above.
2. API deploy needed before on-device profile testing (`deploy-api` — migrations auto-run on boot).
3. **Live role-by-role sessions:** hotload via `start-metro`; log in as each role's seeded user; review dashboard + settings; tweak configs live (Metro refresh, no rebuild). Build/hotload dev client after each phase per CLAUDE.md.
