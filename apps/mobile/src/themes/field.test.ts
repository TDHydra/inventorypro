import { createRequire } from 'node:module';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// #211 Field Mode theme. Theme files import react-native (Easing) at module
// level, which doesn't exist under `node --test` — same Module._load intercept
// as outbox.test.ts.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const origLoad = Module._load;
// Recursive callable proxy: theme files chain Easing (Easing.out(Easing.quad),
// Easing.bezier(...)), so every property access AND call must yield something
// that supports both again.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyFn: any = new Proxy(function () {}, {
  get: (_t, p) => (p === '__esModule' ? true : anyFn),
  apply: () => anyFn,
});
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native') return anyFn;
  return origLoad.call(this, request, parent, isMain);
};

let field: typeof import('./field').field;
let original: typeof import('./original').original;
let themes: typeof import('./registry').themes;

before(() => {
  field = (requireCjs('./field') as typeof import('./field')).field;
  original = (requireCjs('./original') as typeof import('./original')).original;
  themes = (requireCjs('./registry') as typeof import('./registry')).themes;
});

test('#211: Field Mode is a registered, selectable theme', () => {
  assert.ok(themes.field, 'registered in the themes map');
  assert.equal(field.id, 'field');
  assert.equal(field.name, 'Field Mode');
});

test('#211: touch targets are bigger than Original across the sized primitives', () => {
  assert.ok(field.components.input.height >= 52, `input height ${field.components.input.height}`);
  assert.ok(field.components.button.minHeight >= 56, `button minHeight ${field.components.button.minHeight}`);
  assert.ok(field.components.fab.size > original.components.fab.size, 'bigger FAB');
});

test('#211: every font size is larger than its Original counterpart', () => {
  for (const [k, v] of Object.entries(field.typography.fontSizes)) {
    const base = original.typography.fontSizes[k as keyof typeof original.typography.fontSizes];
    assert.ok(v > base, `fontSizes.${k}: ${v} > ${base}`);
  }
});

test('#211: borders are thicker for sunlight legibility', () => {
  assert.ok(field.components.input.borderWidth >= 2, 'input border');
  assert.ok(field.components.card.borderWidth >= 2, 'card border');
  assert.notEqual(field.colors.border, original.colors.border, 'stronger border color');
});
