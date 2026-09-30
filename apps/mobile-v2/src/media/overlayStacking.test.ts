import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ABOVE_SHEET_Z, RNW_MODAL_Z } from '../../../../packages/ui/src/components/ui/overlayZ';

// #287 regression guard. MediaGallery.web.tsx portals its source picker, note
// sheet and lightbox to document.body, and the gallery is also rendered INSIDE a
// ModalSheet (the per-unit "Photos — <asset tag>" sheet on the equipment
// screen). On web ModalSheet is a react-native-web <Modal>, which stamps
// z-index 9999 on its wrapper — so an overlay below that mounts fine but is
// painted behind the sheet and is completely unclickable.
//
// Asserted against the INSTALLED react-native-web rather than a copied literal:
// the failure mode we actually care about is a future RNW upgrade raising its
// Modal z-index past ours, which a hardcoded 9999 in the test would hide.

const require_ = createRequire(import.meta.url);

function installedRnwModalZ(): number {
  const src = readFileSync(
    require_.resolve('react-native-web/dist/exports/Modal/ModalAnimation.js'),
    'utf8',
  );
  const matches = [...src.matchAll(/zIndex:\s*(\d+)/g)].map(m => Number(m[1]));
  assert.ok(
    matches.length > 0,
    'could not find a zIndex in react-native-web ModalAnimation — the Modal internals moved, so re-check where ModalSheet gets its stacking order',
  );
  return Math.max(...matches);
}

test('#287: a portaled web overlay outranks the ModalSheet it opens from', () => {
  assert.ok(
    ABOVE_SHEET_Z > installedRnwModalZ(),
    `ABOVE_SHEET_Z (${ABOVE_SHEET_Z}) must exceed react-native-web's Modal z-index ` +
    `(${installedRnwModalZ()}), or MediaGallery's picker/lightbox render behind the sheet`,
  );
});

test('#287: the recorded RNW z-index still matches the installed package', () => {
  // If this fails, RNW changed its Modal stacking: update RNW_MODAL_Z (and the
  // comment in overlayZ.ts) so the documented floor stays truthful.
  assert.equal(RNW_MODAL_Z, installedRnwModalZ());
});
