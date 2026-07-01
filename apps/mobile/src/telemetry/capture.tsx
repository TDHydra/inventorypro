import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, View, Text, StyleSheet, type GestureResponderEvent, type PressableProps } from 'react-native';
import { track } from './index';
import { colors, spacing, fontSizes, radii } from '../theme';

// ── Error boundary ───────────────────────────────────────────────────────

interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { hasError: boolean }

/**
 * Catches render crashes anywhere below it in the tree, reports a non-PII
 * telemetry event (error *name* only — e.g. "TypeError" — never the message,
 * which can embed field content), and renders a minimal recovery screen
 * instead of a blank white crash. Wrap the root `<Stack/>` with this in
 * app/_layout.tsx.
 */
export class TelemetryErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    track('error', 'render_crash', { props: { reason: error?.name || 'Error' } });
  }

  reset = (): void => this.setState({ hasError: false });

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.fallback}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            This screen ran into a problem. Your data is safe — try again or reopen the app.
          </Text>
          <Pressable style={styles.button} onPress={this.reset}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: spacing.xl, backgroundColor: colors.background,
  },
  title: { fontSize: fontSizes.lg, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.sm },
  body: { fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center', marginBottom: spacing.lg },
  button: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radii.md },
  buttonText: { color: '#fff', fontWeight: '600' },
});

// ── Unhandled errors / rejections ─────────────────────────────────────────

let globalHandlersInstalled = false;

/**
 * Installs a global JS error handler + unhandled-promise-rejection listener
 * that report an 'error'/'unhandled' telemetry event (reason = error name
 * only) before falling through to whatever handler was already registered —
 * so RN's existing red-box / crash-reporting behavior is preserved. Call once
 * at root (e.g. alongside <TelemetryErrorBoundary> wiring in _layout.tsx).
 * Idempotent — safe to call more than once (e.g. Fast Refresh).
 */
export function installGlobalErrorTracking(): void {
  if (globalHandlersInstalled) return;
  globalHandlersInstalled = true;

  try {
    const errorUtils = (globalThis as any).ErrorUtils;
    if (errorUtils && typeof errorUtils.getGlobalHandler === 'function') {
      const prevHandler = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
        track('error', 'unhandled', { props: { reason: error?.name || 'Error' } });
        prevHandler?.(error, isFatal);
      });
    }
  } catch {
    // No RN ErrorUtils in this environment (e.g. web) — skip.
  }

  try {
    (globalThis as any).addEventListener?.('unhandledrejection', (event: any) => {
      const reason = event?.reason;
      const name = reason instanceof Error ? reason.name : (typeof reason === 'string' ? 'string' : 'unknown');
      track('error', 'unhandled', { props: { reason: name } });
    });
  } catch {
    // Environment doesn't support addEventListener('unhandledrejection', ...) — skip.
  }
}

// ── Tap tracking ───────────────────────────────────────────────────────────

interface TrackablePressableProps extends PressableProps {
  /** Event name for this control — falls back to testID/accessibilityLabel. */
  name?: string;
  /** Screen context tag (e.g. route name) attached to the tap event. */
  screen?: string;
}

/**
 * Thin wrapper over Pressable that fires an 'action' telemetry event on
 * press, named after `name` (or the element's testID/accessibilityLabel) and
 * tagged with `screen`. Adopt on high-traffic controls (hub tiles, quick-add
 * save buttons, checkout/checkin) rather than globally hijacking every press.
 */
export function TrackablePressable({ name, screen, onPress, testID, accessibilityLabel, ...rest }: TrackablePressableProps) {
  const eventName = name ?? testID ?? accessibilityLabel ?? 'tap';
  const handlePress = (event: GestureResponderEvent) => {
    track('action', eventName, { screen });
    onPress?.(event);
  };
  return (
    <Pressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      onPress={handlePress}
      {...rest}
    />
  );
}
