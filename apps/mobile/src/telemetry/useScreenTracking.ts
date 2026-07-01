import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import { track } from './index';

/**
 * Reports a 'screen' telemetry event on every route change, named after the
 * route just entered and carrying `durationMs` = time spent on the PREVIOUS
 * route (0 / omitted for the very first screen of a session). Call once near
 * the app root (inside app/_layout.tsx, below the router).
 */
export function useScreenTracking(): void {
  const pathname = usePathname();
  const prevScreenRef = useRef<string | null>(null);
  const prevTsRef = useRef<number>(Date.now());

  useEffect(() => {
    const now = Date.now();
    const isFirstScreen = prevScreenRef.current === null;
    const durationMs = now - prevTsRef.current;

    track('screen', pathname, isFirstScreen ? undefined : { props: { durationMs } });

    prevScreenRef.current = pathname;
    prevTsRef.current = now;
  }, [pathname]);
}
