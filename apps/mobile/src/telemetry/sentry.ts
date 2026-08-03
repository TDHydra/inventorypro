import * as Sentry from '@sentry/react-native';
import { isTelemetryEnabled } from './index';
import { redactProps } from './redact';

/**
 * Crash reporting via @sentry/react-native, pointed at our self-hosted
 * GlitchTip instance (speaks the Sentry protocol). This is a SECOND, narrow
 * crash channel layered on top of the existing first-party telemetry
 * pipeline (./index, ./capture) — not a replacement for it. It reuses the
 * same kill switch (isTelemetryEnabled) and the same PII allowlist
 * (redactProps) rather than inventing parallel ones.
 *
 * Two independent off-switches, both honored:
 *  - Build-time: no DSN configured, or EXPO_PUBLIC_TELEMETRY === '0' baked
 *    into the build → initSentry() never calls Sentry.init(), so the native
 *    crash handler never installs at all.
 *  - Remote (DB-backed): app_config.telemetry_enabled, checked in
 *    beforeSend on every event — this also drops a previous session's
 *    native crash, which Sentry re-surfaces through the JS layer on the
 *    NEXT launch after the DB is available.
 *
 * No tracing/replay/screenshot options are set anywhere in this file —
 * tracesSampleRate/profilesSampleRate/replay*Rate are simply omitted (the
 * SDK only turns tracing on when one of those is present), and
 * attachScreenshot/attachViewHierarchy are explicitly false.
 */

let initialized = false;

export function initSentry(): void {
  try {
    const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    if (!dsn || process.env.EXPO_PUBLIC_TELEMETRY === '0') return;

    Sentry.init({
      dsn,
      debug: __DEV__,
      environment: __DEV__ ? 'development' : 'production',
      sendDefaultPii: false,
      attachScreenshot: false,
      attachViewHierarchy: false,
      enableAutoPerformanceTracing: false,
      beforeSend(event) {
        // Remote kill switch: enforced here (not just at the build-time
        // guard above) so a device that had telemetry_enabled flipped off
        // after this launch's Sentry.init() already ran — or a previous
        // session's native crash re-surfaced through the JS layer on this
        // launch — is still dropped before it leaves the device.
        if (!isTelemetryEnabled()) return null;
        return event;
      },
    });
    initialized = true;
  } catch {
    // Telemetry must never break the app.
  }
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  try {
    if (!initialized) return;
    Sentry.captureException(error, extra ? { extra: redactProps(extra) } : undefined);
  } catch {
    // Telemetry must never break the app.
  }
}
