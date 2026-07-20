import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_DEFAULT_LAYOUTS } from './roleLayouts';
import { WIDGET_REGISTRY, isWidgetType, type StatSource, type WorkListSource } from './widgets';
import { ROLE_TIER, type UserRole } from '../constants/roles';

// Every role the app knows about (ROLE_TIER is a total Record<UserRole, …>).
const ALL_ROLES = Object.keys(ROLE_TIER) as UserRole[];

const STAT_SOURCES: StatSource[] = [
  'my-checkouts', 'open-repairs', 'units-due-service', 'low-stock', 'open-jobs', 'team-members',
];
const WORK_LIST_SOURCES: WorkListSource[] = [
  'my-equipment', 'open-jobs', 'open-repairs', 'units-due-service', 'low-stock',
];

// --- §3: every one of the 13 roles ships a starter layout --------------------

test('every UserRole resolves to a non-empty role default layout', () => {
  assert.equal(ALL_ROLES.length, 13, '13 roles');
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

test('crew roles lead with the fast checkout/check-in pair and list "My equipment"', () => {
  const crew: UserRole[] = ['mitigation_technician', 'contents_crew', 'construction_crew', 'carpet_cleaning_crew'];
  for (const role of crew) {
    const layout = ROLE_DEFAULT_LAYOUTS[role]!;
    assert.equal(layout[0].widget, 'fast-checkout', `${role}: fast-checkout first`);
    assert.equal(layout[1].widget, 'fast-checkin', `${role}: fast-checkin second`);
    const widgets = layout.map(b => b.widget);
    assert.ok(widgets.includes('on-call'), `${role}: on-call present`);
    const wl = layout.find(b => b.widget === 'work-list');
    assert.equal(wl?.config?.source, 'my-equipment', `${role}: my-equipment work list`);
  }
});

test('temporary_employee gets fast tiles + "My equipment" ONLY', () => {
  const layout = ROLE_DEFAULT_LAYOUTS.temporary_employee!;
  assert.deepEqual(layout.map(b => b.widget), ['fast-checkout', 'fast-checkin', 'work-list']);
  assert.equal(layout[2].config?.source, 'my-equipment');
});

test('tier-2 managers get the 4 org stat tiles + open-jobs list + activity', () => {
  const managers: UserRole[] = ['production_manager', 'head_of_construction', 'head_of_contents', 'carpet_cleaning_manager'];
  for (const role of managers) {
    const layout = ROLE_DEFAULT_LAYOUTS[role]!;
    const stats = layout.find(b => b.widget === 'stat-tiles')?.config?.stats;
    assert.deepEqual(stats, ['open-jobs', 'open-repairs', 'low-stock', 'units-due-service'], `${role}: stat set`);
    assert.equal(layout.find(b => b.widget === 'work-list')?.config?.source, 'open-jobs', `${role}: open jobs list`);
    const widgets = layout.map(b => b.widget);
    assert.ok(widgets.includes('activity-preview'), `${role}: activity preview`);
    assert.ok(widgets.includes('low-stock'), `${role}: low-stock list`);
  }
});

test('hr_manager is people-centric: team-members stat + users/teams/logs tiles', () => {
  const layout = ROLE_DEFAULT_LAYOUTS.hr_manager!;
  assert.deepEqual(layout.find(b => b.widget === 'stat-tiles')?.config?.stats, ['team-members']);
  const widgets = layout.map(b => b.widget);
  for (const w of ['users', 'teams', 'logs'] as const) assert.ok(widgets.includes(w), `hr: ${w} tile`);
});

test('franchise_manager/full_admin get admin nav tiles + no fast tiles', () => {
  for (const role of ['franchise_manager', 'full_admin'] as const) {
    const widgets = ROLE_DEFAULT_LAYOUTS[role]!.map(b => b.widget);
    for (const w of ['users', 'roles', 'settings', 'activity-preview'] as const) {
      assert.ok(widgets.includes(w), `${role}: ${w} present`);
    }
    assert.ok(!widgets.includes('fast-checkout'), `${role}: no fast tiles`);
  }
});
