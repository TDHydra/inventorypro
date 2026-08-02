import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// #197/#198: view_teams/view_locations only ever locked the dashboard shortcut
// tile — the actual screens (teams/locations list + detail) never checked them,
// so search results, scan, repair-detail links, and deep links all routed
// straight in regardless of the role's permission. Fixed by gating each screen
// itself (PermissionGate's new 'screen' mode) rather than just the entry point.
//
// These route components import db/queries/* -> db/schema -> op-sqlite (native),
// which does not load under `node --test` (same constraint as pull.ts/
// fullDownload.ts — see pullColumns.test.ts / fullDownload.test.ts). So this
// asserts against source text instead of rendering the screens.

const HERE = dirname(new URL(import.meta.url).pathname);
const GATE_SRC = readFileSync(join(HERE, 'PermissionGate.tsx'), 'utf8');

test("PermissionGate supports a 'screen' mode that renders the house 🔒 EmptyState instead of dimmed children", () => {
  assert.match(GATE_SRC, /mode\?:\s*'hide'\s*\|\s*'disable'\s*\|\s*'screen'/, "Props.mode should be widened to include 'screen'");
  assert.match(GATE_SRC, /mode === 'screen'/, "denied 'screen' mode must be handled explicitly");
  assert.match(GATE_SRC, /icon="🔒"/, "'screen' mode should reuse the established 🔒 EmptyState presentation");
  assert.match(GATE_SRC, /label:\s*'Request access'/, "'screen' mode must still offer the #203 Request-access affordance");
});

const SCREENS: Array<{ path: string; permission: 'view_teams' | 'view_locations' }> = [
  { path: '../../app/(app)/(teams)/index.tsx', permission: 'view_teams' },
  { path: '../../app/(app)/(teams)/[id].tsx', permission: 'view_teams' },
  { path: '../../app/(app)/(locations)/index.tsx', permission: 'view_locations' },
  { path: '../../app/(app)/(locations)/[id].tsx', permission: 'view_locations' },
];

for (const { path, permission } of SCREENS) {
  test(`${path} gates its whole screen on usePermission('${permission}')`, () => {
    const src = readFileSync(join(HERE, path), 'utf8');
    assert.match(
      src,
      new RegExp(`usePermission\\(\\s*['"]${permission}['"]\\s*\\)`),
      `must call usePermission('${permission}') — the old bug was checking manage_* (or nothing) instead`,
    );
    assert.match(
      src,
      new RegExp(`<PermissionGate\\s+permission="${permission}"\\s+mode="screen"`),
      `must render <PermissionGate permission="${permission}" mode="screen" /> when denied — a dashboard-tile-only lock (the #197/#198 bug) leaves this screen reachable via search/scan/deep-link`,
    );
  });
}
