import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '../../sync/netinfo';
import { getOutboxCounts } from '../../sync/outbox';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { evaluateOfflineBanner } from './offlineBannerState';

/**
 * #215: persistent "Working offline — N changes queued" strip at the app
 * shell (the PreviewBanner root-strip pattern, mounted below it in
 * app/(app)/_layout.tsx). Replaces the easy-to-miss 10px sync dot as the
 * offline signal. Self-contained: renders nothing while connected, so the
 * shell mounts it unconditionally.
 *
 * Connectivity comes from the same NetInfo source sync/engine.ts trusts, and
 * only a definite `false` shows the banner (see offlineBannerState.ts). The
 * queued count polls getOutboxCounts on the SyncIndicator's 5s cadence —
 * outbox writes don't fire reactive table notifications, so polling is the
 * house precedent here, and only while offline (no cost in the normal case).
 */
export function OfflineBanner() {
  const s = useThemedStyles(makeStyles);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (isConnected !== false) return;
    const read = () => {
      try {
        const { active, failed } = getOutboxCounts();
        setQueued(active + failed);
      } catch { /* pre-DB-init render — keep the last count */ }
    };
    read();
    const interval = setInterval(read, 5000);
    return () => clearInterval(interval);
  }, [isConnected]);

  const text = evaluateOfflineBanner(isConnected, queued);
  if (text == null) return null;

  return (
    <View style={s.banner}>
      <Text style={s.text} numberOfLines={1}>{text}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // No safe-area padding: PreviewBanner (or the Stack header) above already
  // owns the inset; this strip sits in normal shell flow like the
  // maintenance banners.
  banner: {
    backgroundColor: t.colors.textSecondary,
    paddingHorizontal: t.spacing.base,
    paddingVertical: 6,
    alignItems: 'center',
  },
  text: {
    color: t.colors.surface,
    fontWeight: t.typography.weights.bold,
    fontSize: t.typography.fontSizes.caption,
  },
});
