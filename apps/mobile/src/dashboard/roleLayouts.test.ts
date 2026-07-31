import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_DEFAULT_LAYOUTS } from './roleLayouts';
import { WIDGET_REGISTRY, isWidgetType, type StatSource, type WorkListSource } from './widgets';
import { ROLE_TIER, type UserRole } from '../constants/roles';

// Every role the app knows about (ROLE_TIER is a total Record<UserRole, …>).
const ALL_ROLES = Object.keys(ROLE_TIER) as UserRole[];

const STAT_SOURCES: StatSource[] = [
  'my-checkouts', 'open-repairs', 'units-due-service', 'low-stock', 'open-jobs', 'team-members',
  'vehicles-available', 'shared-media',
];
const WORK_LIST_SOURCES: WorkListSource[] = [
  'my-equipment', 'my-jobs', 'open-jobs', 'open-repairs', 'units-due-service', 'low-stock', 'vehicles',
];

// --- §3: every one of the 14 roles ships a starter layout --------------------

test('every UserRole resolves to a non-empty role default layout', () => {
  assert.equal(ALL_ROLES.length, 14, '14 roles');
  for (const role of ALL_ROLES) {
    const layout = ROLE_DEFAULT_LAYOUTS[role];
    assert.ok(Array.isArray(layout) && layout.length > 0, `${role}: non-empty layout`);
  }
});

test('every referenced widget type exists in WIDGET_REGISTRY, with a valid width', () => {
  for (const role of ALL_ROLES) {
    for (const b of ROLE_DEFAULT_LAYOUTS[role]!) {
      assert.ok(isWidgetType(b.widget), `${role}: '${b.widget}' is a registered widget`);
      assert.ok(b.widget in WIDGET_REGISTRY, `${role}: '${b.widget}' in registry`);
      assert.ok(b.width === 'full' || b.width === 'half', `${role}: valid width`);
    }
  }
});

test('configured data widgets carry valid sources', () => {
  for (const role of ALL_ROLES) {
    for (const b of ROLE_DEFAULT_LAYOUTS[role]!) {
      if (b.widget === 'stat-tiles') {
        const stats = b.config?.stats;
        assert.ok(Array.isArray(stats) && stats.length > 0, `${role}: stat-tiles has stats`);
        for (const s of stats!) assert.ok(STAT_SOURCES.includes(s), `${role}: stat source '${s}'`);
      }
      if (b.widget === 'work-list') {
        const src = b.config?.source;
        assert.ok(src && WORK_LIST_SOURCES.includes(src), `${role}: work-list source '${src}'`);
      }
    }
  }
});

// --- Spot checks on the §3 role groups ---------------------------------------

test('crew roles lead with the fast checkout/check-in pair and list "My jobs" + "My equipment"', () => {
  const crew: UserRole[] = ['mitigation_technician', 'contents_crew', 'construction_crew', 'carpet_cleaning_crew', 'duct_cleaning_technician'];
  for (const role of crew) {
    const layout = ROLE_DEFAULT_LAYOUTS[role]!;
    assert.equal(layout[0].widget, 'fast-checkout', `${role}: fast-checkout first`);
    assert.equal(layout[1].widget, 'fast-checkin', `${role}: fast-checkin second`);
    const widgets = layout.map(b => b.widget);
    assert.ok(widgets.includes('on-call'), `${role}: on-call present`);
    const sources = layout.filter(b => b.widget === 'work-list').map(b => b.config?.source);
    // #160: my-jobs (assigned via my crew or directly) leads, my-equipment follows.
    assert.deepEqual(sources, ['my-jobs', 'my-equipment'], `${role}: my-jobs + my-equipment work lists`);
  }
});

// #177: "daily driver" crew stat set — my counts, then vehicle availability.
test('crew roles show the my-checkouts + vehicles-available stat set (#177)', () => {
  const crew: UserRole[] = ['mitigation_technician', 'contents_crew', 'construction_crew', 'carpet_cleaning_crew'];
  for (const role of crew) {
    const layout = ROLE_DEFAULT_LAYOUTS[role]!;
    const stats = layout.find(b => b.widget === 'stat-tiles')?.config?.stats;
    assert.deepEqual(stats, ['my-checkouts', 'vehicles-available', 'shared-media'], `${role}: stat set`);
  }
});

test('temporary_employee gets fast tiles + shared-media pill + "My jobs" + "My equipment" ONLY', () => {
  const layout = ROLE_DEFAULT_LAYOUTS.temporary_employee!;
  assert.deepEqual(layout.map(b => b.widget), ['fast-checkout', 'fast-checkin', 'stat-tiles', 'work-list', 'work-list']);
  assert.deepEqual(layout[2].config?.stats, ['shared-media']);
  assert.equal(layout[3].config?.source, 'my-jobs');
  assert.equal(layout[4].config?.source, 'my-equipment');
});

test('tier-2 managers KEEP the open-jobs list (not my-jobs) + 4 org stat tiles + activity', () => {
  const managers: UserRole[] = ['production_manager', 'head_of_construction', 'head_of_contents', 'carpet_cleaning_manager'];
  for (const role of managers) {
    const layout = ROLE_DEFAULT_LAYOUTS[role]!;
    const stats = layout.find(b => b.widget === 'stat-tiles')?.config?.stats;
    assert.deepEqual(stats, ['open-jobs', 'open-repairs', 'low-stock', 'units-due-service', 'shared-media'], `${role}: stat set`);
    assert.equal(layout.find(b => b.widget === 'work-list')?.config?.source, 'open-jobs', `${role}: open jobs list`);
    assert.ok(!layout.some(b => b.config?.source === 'my-jobs'), `${role}: managers keep the org-wide list`);
    const widgets = layout.map(b => b.widget);
    assert.ok(widgets.includes('activity-preview'), `${role}: activity preview`);
    assert.ok(widgets.includes('low-stock'), `${role}: low-stock list`);
  }
});

test('hr_manager is people-centric: team-members stat + users/teams/logs tiles', () => {
  const layout = ROLE_DEFAULT_LAYOUTS.hr_manager!;
  assert.deepEqual(layout.find(b => b.widget === 'stat-tiles')?.config?.stats, ['team-members', 'shared-media']);
  const widgets = layout.map(b => b.widget);
  for (const w of ['users', 'teams', 'logs'] as const) assert.ok(widgets.includes(w), `hr: ${w} tile`);
});

test('franchise_manager/full_admin get admin nav tiles + the full button set', () => {
  // Live review 2026-07-20: admins keep the ENTIRE default button set (fast
  // tiles included) with data widgets layered on top.
  for (const role of ['franchise_manager', 'full_admin'] as const) {
    const widgets = ROLE_DEFAULT_LAYOUTS[role]!.map(b => b.widget);
    for (const w of ['users', 'roles', 'settings', 'activity-preview', 'fast-checkout', 'fast-checkin', 'stat-tiles'] as const) {
      assert.ok(widgets.includes(w), `${role}: ${w} present`);
    }
  }
});

// #165: every tier-2+ manager and crew dashboard surfaces Vehicles + Lockers.
test('tier-2 manager layouts include vehicles and lockers tiles (#165)', () => {
  for (const role of ALL_ROLES) {
    const tier = ROLE_TIER[role];
    if (tier < 1 || tier > 2 || role === 'temporary_employee' || role === 'office_manager') continue;
    const widgets = ROLE_DEFAULT_LAYOUTS[role]!.map(b => b.widget);
    assert.ok(widgets.includes('vehicles'), `${role}: vehicles tile`);
    assert.ok(widgets.includes('lockers'), `${role}: lockers tile`);
  }
});
