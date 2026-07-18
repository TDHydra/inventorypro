# Plan — Frontend Hardening (web + mobile, comprehensive)

## Context
Covers the Expo **web** build (nginx at frontend.plexcontrol.com) and the React Native **mobile** client. Already shipped: nginx security headers (CSP/X-Frame-Options/nosniff/HSTS/Referrer-Policy), `sanitizeScan` input bounding, client permission gates (checkout/checkin), themed alerts, transaction-wrapped writes, idle logout + biometric unlock (mobile). This plan is the remaining **defense-in-depth** — token/data-at-rest exposure, build/signing integrity, transport, and device hardening. Scope: `apps/mobile` + `infra`. Grounded in a read-only recon (2026-06-30); the P0 items below were code-verified.

The primary defense is server-side (the API plan); these reduce client attack surface and data leakage on shared/compromised devices.

---

## Phase 1 — P0 (verified, ship first)
1. **Release APK is signed with the DEBUG keystore** — `android/app/build.gradle:112-115`: the `release` buildType uses `signingConfigs.debug` (`debug.keystore`, password "android"). Anyone can repackage + resign; not Play-Store-acceptable. **Fix:** generate a real release keystore, add a `release` signingConfig sourced from env/EAS credentials (never commit the keystore), point the release buildType at it. Wire into the build flow + EAS credentials. (S)
2. **Web token + full dataset unencrypted in IndexedDB** — `src/auth/session.web.ts` stores JWT + refresh token in IndexedDB, and `src/db/webPersistence.ts` persists the entire sql.js dataset (items, users, roles, jobs, locations) unencrypted. Any XSS or shared-machine access → full read. **Fix (choose, likely both):**
   - Move web auth to **httpOnly Secure SameSite=Strict cookies** (pairs with the API plan's cookie item) so tokens aren't JS-readable; and/or
   - Encrypt the IndexedDB snapshot (key derived from a session secret) and/or **minimize** what persists; add **web idle-timeout + wipe** (see #8) so an idle shared browser clears tokens + cached DB. (M; biggest web item — its own brainstorm→spec)

## Phase 2 — P1 (high impact)
3. **Leaflet loaded from unpkg CDN without SRI** — `src/components/MapPickerModal.tsx:29-30` + `MapDisplay.tsx:21-22` load `leaflet.js`/`.css` from `unpkg.com` inside the map WebView. CDN compromise / MITM → arbitrary code in the map context (location data exfiltration). **Fix:** self-host Leaflet in the app bundle (preferred — removes the external dependency), or add SRI `integrity` hashes + pin. (S)
4. **CSP allows `'unsafe-inline'` for styles** — `infra/nginx-web.conf` `style-src 'self' 'unsafe-inline'` (RN-Web injects inline styles). Weakens the CSP against style-based exfiltration. **Fix:** evaluate moving RN-Web to nonce/hash styles or an extracted stylesheet, then drop `'unsafe-inline'`. Verify the app still renders (RN-Web inline styles are the blocker — may be partial). (M)
5. **Web build may ship source maps** — `infra/Dockerfile.web` has no explicit sourcemap handling; if `expo export` emits `.map` files they're served publicly (logic/schema leak). **Fix:** confirm whether maps are emitted; if so, exclude them from the nginx-served `dist` (or set `EXPO_NO_SOURCE_MAPS`/equivalent). (S)
6. **`allowBackup="true"`** — `AndroidManifest.xml:20`. NOTE: it already references `fullBackupContent=@xml/secure_store_backup_rules` + `dataExtractionRules=@xml/secure_store_data_extraction_rules`, so backups are partially scoped. **Fix:** verify those rule files actually exclude the SecureStore/token/DB paths; if coverage is incomplete, set `allowBackup="false"` or tighten the rules. (S — mostly verification)
7. **`FLAG_SECURE` on sensitive screens (optional/maturity)** — no screenshot/recent-apps protection on login, checkout, item detail. **Fix:** apply native screen protection on production builds for sensitive screens. Lower priority (internal-tool threat model). (M)
8. **Web idle-timeout + wipe** — mobile has `useIdleLogout`; web has none, and web holds persistent tokens + cached DB. **Fix:** add an idle timeout on web that clears tokens + IndexedDB and forces re-auth. (S) — strongly recommended alongside #2.

## Phase 3 — P2 (maturity / advanced, mostly optional)
9. **Certificate pinning for api.plexcontrol.com** — prevents token theft via rogue-CA/MITM. Native pinning (Android network-security-config / OkHttp by hash). Adds cert-rotation operational burden — weigh vs HSTS already in place. (M)
10. **Dependency scanning** — fold `pnpm audit --audit-level=high` + Dependabot for `apps/mobile/package.json` into the shared CI from the API plan (#6 there). (S)
11. **Route-param validation (defense-in-depth)** — dynamic routes (`[id].tsx`) trust `useLocalSearchParams`; DB lookups already null-guard, so low risk. Add UUID/length validation as belt-and-suspenders. (S)
12. **Play Integrity / root-jailbreak detection** — attest device legitimacy / warn on rooted devices. Advanced; significant setup (Play Console + server validation). Recommend only if the threat model warrants. (L) — **optional**
13. **JS obfuscation (web)** — minified but not obfuscated; reveals client logic. Low value (server-side validation is the real defense) — **optional, likely skip.** (M)
14. **Central input validation (lengths/charset)** — beyond `sanitizeScan`, form text inputs accept unbounded strings (DoS/log-injection on the server). Add shared max-length/charset validation to forms. (S)
15. **Service worker (only if PWA added later)** — `nginx-web.conf` reserves `sw.js`/`manifest.json` locations but none exist. If a SW is added: version-scoped caching only, never cache tokens, strict CSP, no stale-as-fresh data. (M, conditional)

## Verification
- tsc (mobile) clean; web rebuild + redeploy; browser checks: no `.map` served, no `unpkg` request from the map view (self-hosted), CSP has no `'unsafe-inline'` if #4 lands, idle timeout wipes tokens+DB.
- Device: install the **release-keystore-signed** APK (`adb install`), confirm sensitive screens honor FLAG_SECURE (if #7), confirm cert pinning rejects a proxy (if #9).
- Confirm backup rules exclude token/DB paths (`adb backup` test) for #6.

## Notes / sequencing
- **#1 (release signing)** is the cheapest real win — do immediately. **#2 (web token/data-at-rest)** is the most consequential and pairs with the API plan's httpOnly-cookie item — spec the two together. **#3/#5/#6/#8** are small, high-value web/build items. Phase 3 is largely optional for an internal field tool; pick by threat model.
- #2 ↔ API plan #16 (httpOnly cookies); #10 ↔ API plan #6 (shared CI); #9 interacts with the existing HSTS.
