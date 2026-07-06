import { useEffect, useRef } from 'react';
import { usePathname } from 'expo-router';
import { track } from './index';

// usePathname() resolves dynamic route segments to LIVE values (e.g.
// /(app)/(inventory)/<item-uuid>), so the raw path would put entity ids into
// the screen name. Collapse UUIDs and all-numeric segments back to ':id' so we
// track the route PATTERN, not the specific record.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function routePattern(pathname: string): string {
  return pathname
    .split('/')
    .map(seg => (UUID_RE.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}

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

    track('screen', routePattern(pathname), isFirstScreen ? undefined : { props: { durationMs } });

    prevScreenRef.current = pathname;
    prevTsRef.current = now;
  }, [pathname]);
}
