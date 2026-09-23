import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_DASHBOARDS } from './presets';
import { ROLE_TIER, UserRole } from '../constants/roles';

// Coverage guardrail (same pattern as roles.test.ts's PERMISSION_LABELS
// exhaustiveness test): TS enforces Record<UserRole, …> at compile time, but
// this also catches a role added to ROLE_TIER without a conscious dashboard
// decision — and duplicate ids inside one layout, which would render twice.
test('every role has a dashboard with unique, non-empty content', () => {
  for (const role of Object.keys(ROLE_TIER) as UserRole[]) {
    const dash = ROLE_DASHBOARDS[role];
    assert.ok(dash, `missing dashboard for ${role}`);
    assert.ok(dash.stats.length > 0, `${role} has no stat tiles`);
    assert.equal(new Set(dash.stats).size, dash.stats.length, `${role} has duplicate stats`);
    assert.equal(new Set(dash.lists).size, dash.lists.length, `${role} has duplicate lists`);
  }
});

test('quick actions are crew-only (old CREW_LAYOUT was the only carrier)', () => {
  for (const [role, dash] of Object.entries(ROLE_DASHBOARDS)) {
    if (dash.quickActions) {
      assert.equal(ROLE_TIER[role as UserRole], 1, `${role} is not tier-1 but has quickActions`);
      assert.notEqual(role, 'temporary_employee');
    }
  }
});
