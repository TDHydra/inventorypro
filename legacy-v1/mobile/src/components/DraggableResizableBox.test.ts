import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SIZE, clampMove, clampResize, buildBoxResponders,
  type BoxResponderDeps,
} from './DraggableResizableBox';

/** Round to 6 dp so float noise (0.30000000000000004) doesn't fail deep-equal. */
const r6 = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1e6) / 1e6]));

// ── Pure geometry ───────────────────────────────────────────────────────────
test('clampMove converts pixel delta to normalized position', () => {
  // 100px right on a 200px canvas = +0.5 in normalized space
  assert.deepEqual(clampMove({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 100, 40, 200, 200),
    { x: 0.6, y: 0.4 });
});

test('clampMove keeps the box on-canvas (x/y in [0, 1-w] / [0, 1-h])', () => {
  // Big positive delta clamps to 1-w and 1-h, not past the edge.
  assert.deepEqual(clampMove({ x: 0.5, y: 0.5, w: 0.3, h: 0.4 }, 9999, 9999, 200, 200),
    { x: 0.7, y: 0.6 });
  // Big negative delta clamps to 0.
  assert.deepEqual(clampMove({ x: 0.5, y: 0.5, w: 0.3, h: 0.4 }, -9999, -9999, 200, 200),
    { x: 0, y: 0 });
});

test('clampResize anchors to captured start size, floors at minSize', () => {
  // start 0.4 wide, +100px on 200px canvas -> +0.5 -> 0.9
  assert.deepEqual(clampResize(0.4, 0.4, { x: 0.05, y: 0.05, w: 0.4, h: 0.4 }, 100, 100, 200, 200),
    { w: 0.9, h: 0.9 });
  // Shrinking past the floor clamps to minSize.
  assert.deepEqual(clampResize(0.4, 0.4, { x: 0, y: 0, w: 0.4, h: 0.4 }, -9999, -9999, 200, 200),
    { w: MIN_SIZE, h: MIN_SIZE });
});

test('clampResize ceilings width/height so the box stays inside the canvas', () => {
  // x=0.7 -> max width 0.3 regardless of a huge grow delta.
  assert.deepEqual(r6(clampResize(0.2, 0.2, { x: 0.7, y: 0.8, w: 0.2, h: 0.2 }, 9999, 9999, 200, 200)),
    { w: 0.3, h: 0.2 });
});

// ── Responder builder / arbitration ─────────────────────────────────────────
function makeDeps(overrides: Partial<BoxResponderDeps> = {}) {
  const calls = {
    change: [] as Array<[string, Record<string, number>]>,
    select: [] as string[],
    dragStart: 0, dragEnd: 0, resetPan: 0, dragMove: 0,
  };
  const state = { rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 }, canvas: { w: 200, h: 200 }, id: 'box-1', minSize: MIN_SIZE };
  const deps: BoxResponderDeps = {
    getRect: () => state.rect,
    getCanvas: () => state.canvas,
    getId: () => state.id,
    getMinSize: () => state.minSize,
    onChange: (id, patch) => calls.change.push([id, patch]),
    onSelect: (id) => calls.select.push(id),
    onDragStart: () => { calls.dragStart++; },
    onDragEnd: () => { calls.dragEnd++; },
    dragMove: () => { calls.dragMove++; },
    resetPan: () => { calls.resetPan++; },
    ...overrides,
  };
  return { deps, calls, state };
}

test('drag body claims the gesture on start and on move', () => {
  const { deps } = makeDeps();
  const { drag } = buildBoxResponders(deps);
  assert.equal(drag.onStartShouldSetPanResponder(), true);
  assert.equal(drag.onMoveShouldSetPanResponder(), true);
});

test('resize handle REFUSES to yield the responder (the fix)', () => {
  // This is the core arbitration fix: without termination-request=false the
  // parent body-drag steals the corner gesture on the first move.
  const { deps } = makeDeps();
  const { resize } = buildBoxResponders(deps);
  assert.equal(typeof resize.onPanResponderTerminationRequest, 'function');
  assert.equal(resize.onPanResponderTerminationRequest!(), false);
  // And the resize handle still wins the touch start (deepest node) on its own.
  assert.equal(resize.onStartShouldSetPanResponder(), true);
});

test('drag does NOT refuse termination the way resize does', () => {
  // The body drag has no reason to hold the responder hostage; only the corner
  // needs to. If it existed and returned false it would fight nested scrolls.
  const { deps } = makeDeps();
  const { drag } = buildBoxResponders(deps);
  const req = drag.onPanResponderTerminationRequest;
  assert.ok(req === undefined || req() === true);
});

test('grant selects the box and starts the drag freeze', () => {
  const { deps, calls } = makeDeps();
  const { drag } = buildBoxResponders(deps);
  drag.onPanResponderGrant();
  assert.equal(calls.dragStart, 1);
  assert.deepEqual(calls.select, ['box-1']);
});

test('drag release commits a clamped move and unfreezes/resets', () => {
  const { deps, calls } = makeDeps();
  const { drag } = buildBoxResponders(deps);
  drag.onPanResponderGrant();
  drag.onPanResponderRelease(null, { dx: 40, dy: 40 });
  assert.equal(calls.dragEnd, 1);
  assert.equal(calls.resetPan, 1);
  // 40/200 = 0.2 added to 0.1 => 0.3
  assert.equal(calls.change.length, 1);
  assert.equal(calls.change[0][0], 'box-1');
  assert.deepEqual(r6(calls.change[0][1]), { x: 0.3, y: 0.3 });
});

test('resize move commits a live clamped resize anchored to grant-time size', () => {
  const { deps, calls, state } = makeDeps();
  const { resize } = buildBoxResponders(deps);
  resize.onPanResponderGrant();               // captures start size 0.4 x 0.4
  // Simulate the field having already grown mid-gesture; anchor must NOT drift.
  state.rect = { x: 0.1, y: 0.1, w: 0.6, h: 0.6 };
  resize.onPanResponderMove(null, { dx: 40, dy: 40 });
  // 0.4 (start) + 40/200 = 0.6, NOT 0.6 (current) + 0.2.
  assert.equal(calls.change.length, 1);
  assert.deepEqual(r6(calls.change[0][1]), { w: 0.6, h: 0.6 });
});

test('terminate on either responder unfreezes scroll', () => {
  const { deps, calls } = makeDeps();
  const { drag, resize } = buildBoxResponders(deps);
  drag.onPanResponderTerminate();
  resize.onPanResponderTerminate();
  assert.equal(calls.dragEnd, 2);
});
