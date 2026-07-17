# InventoryPro — delivery timeline

Ordered schedule for the open board (GitHub Project 2). **The board is the source of truth
for status**; this file is only the *order* — what to do on which day, and why that order.
Re-generate or shuffle freely; nothing links to it.

Sizing: 3–5 items/day, batched so each day has one theme (same files, same head-space).
Day 1 = 2026-07-14. 40 open items → ~11 working days.

**Sequencing rules baked into the order below:**
1. **Finish what's started.** `In review` items are already written and only need verification;
   leaving them unmerged means every later change rebases on top of unverified work.
2. **Security before features.** The SEC-M batch is auth/authorization on live prod endpoints.
3. **Correctness before optimization.** The sync-reactivity bugs (#60–#62) come before the
   structural work (#63, #64) that would otherwise force rewriting the same call sites twice.

---

## Day 1 — Tue 2026-07-14 · Verify + close the SEC-M batch
Already written, awaiting verification. Do them together: same API surface, one API deploy.
- #37 SEC-M: Refresh token accepted as access token (no type/audience check)
- #39 SEC-M: Missing write authorization on conversation_participants
- #40 SEC-M: messages UPDATE not gated on membership or sender ownership
- #41 SEC-M: /sync/push entries array has no maxItems bound (DoS)
- #44 SEC-M: Media sync-write path bypasses entity_type allowlist & URL validation

## Day 2 — Wed 2026-07-15 · Drain the rest of `In review`
- #16 SECURITY: bound /auth/token attempts map
- #57 BUG: first-launch full download died on FOREIGN KEY constraint (fixed)
- #51 Media: silent thumbnail prefetch + auto-refreshing media screens
- #67 BUG: demo-account switch blocked by unsynced changes ← *needs on-device test + commit*
- #52 / #53 Test accounts P1+P2 (inactivity nudge; API seeded test users)

## Day 3 — Thu 2026-07-16 · Sync reactivity: the correctness bugs
The user-visible half of "everything should update on sync". All one-liners against existing
`useDataVersion()` — cheap, high payoff.
- #60 BUG: Jobs list never refreshes on sync ← biggest single gap
- #61 BUG: mount-only screens frozen (dashboard low-stock, admin users, taxonomy types)
- #62 Detail screens only refresh on refocus → fold into `useFocusOrDataRefresh()`
- #65 `loadClassConfigCache()` notifies no listeners (latent landmine)

## Day 4 — Fri 2026-07-17 · Sync reactivity: the structural fix
Heavier; do as one design so the call sites are touched once.
- #63 `useDbQuery(fn, deps)` — make screens reactive by default
- #64 Per-table `dataVersion` granularity (the table name is the natural `useDbQuery` arg)
- #18 Componentization Wave 2: ListScreenShell + EntityEditSheet (same screens, same edit pass)

## Day 5 — Mon 2026-07-20 · Security: the lows
- #45 SEC-L: Enrollment codes never expire
- #46 SEC-L: Prod MinIO bucket set to whole-bucket anonymous download
- #47 SEC-L: JWT and user_id persisted as plaintext in IndexedDB
- #48 SEC-L: Assignment notification lets any edit_inventory user spam arbitrary users
- #42 SEC-M: At-rest snapshot encryption gives no real XSS protection

## Day 6 — Tue 2026-07-21 · Sync/auth edges
- #38 SEC-M: Sync users-INSERT skips role-assignment/tier guard (mint apex admin)
- #43 SEC-M: Web idle auto-wipe leaves live in-memory DB and session intact
- #23 Old-APK devices keep leaked team rows until updated
- #58 Test accounts: /sync/full 403s for temporary_employee

## Day 7 — Wed 2026-07-22 · Small bugs + mail
- #34 BUG: chat empty-state text renders mirrored
- #50 BUG: duplicate is_primary race — two primary photos on one job
- #66 Email subject convention — prefix with Notification / Alert / Stock *(SMTP now live)*
- #49 Media hub: multi-select media + bulk delete

## Day 8 — Thu 2026-07-23 · Taxonomy + equipment
- #25 Taxonomy hardening: entity type label → FK id *(already In progress)*
- #15 On-device verification: TaxonomyChips + teams scoping *(already In progress)*
- #28 Equipment: type field backed by the types taxonomy + configurable optional fields

## Day 9 — Fri 2026-07-24 · Features
- #29 Chat/messages system: finish it
- #32 Settings: debug-mode toggle with self-resetting test accounts
- #27 Enrich Activity Logs + Settings→System Analytics

## Day 10 — Mon 2026-07-27 · Scoping + hardening
- #21 Teams scoping follow-ups
- #33 Track device location on more actions, sync with API calls
- #31 Prod hardening: obfuscation, injection-proofing, attempt logging

## Day 11 — Tue 2026-07-28 · Tail + release
- #24 Bulk sample-data auto-generation (dev tool, low priority)
- Buffer / prod APK build + release
