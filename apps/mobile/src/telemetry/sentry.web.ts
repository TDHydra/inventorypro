/**
 * Web shadow of sentry.ts. Same exported surface so the shared call sites
 * (capture.tsx, app/_layout.tsx) work unchanged, but both functions are
 * deliberate no-ops for v1 — browser crash reporting is out of scope
 * (Expo Web here is an internal surface; browser devtools already surface
 * JS errors). Zero imports, so this file is safe to import from a
 * `node --test` unit test (unlike sentry.ts, which pulls in the native
 * @sentry/react-native bridge and would crash under plain node --test).
 */

export function initSentry(): void {}

export function captureException(_error: unknown, _extra?: Record<string, unknown>): void {}
