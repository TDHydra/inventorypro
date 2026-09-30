// #287: stacking order for hand-rolled WEB overlays that must sit above a
// ModalSheet.
//
// On web, ModalSheet renders react-native-web's <Modal>, whose wrapper carries
// `position: fixed; z-index: 9999` (react-native-web/dist/exports/Modal/
// ModalAnimation.js). Anything portaled to document.body with a LOWER z-index
// is painted underneath it — it mounts, it's in the DOM, and it is completely
// unreachable: document.elementFromPoint over the overlay returns the sheet's
// own content, so clicks land on the sheet behind it.
//
// That's the #287 bug: MediaGallery's source picker / note sheet / lightbox all
// used z-index 1000, so inside the per-unit "Photos — <asset tag>" ModalSheet
// tapping "+ Add photo" opened the picker invisibly BEHIND the sheet and
// nothing happened. The same gallery works on a plain screen, which is why only
// per-unit equipment photos were affected.
//
// Native needs none of this (RN Modals stack by mount order), so these are only
// referenced from .web.tsx files.

/**
 * The z-index react-native-web's <Modal> puts on its wrapper. Not ours to set —
 * recorded so the constant below has a documented floor, and so the guard test
 * in apps/mobile-v2 can assert we're still above the installed version's value.
 */
export const RNW_MODAL_Z = 9999;

/**
 * Use for a web overlay portaled to document.body that must cover a ModalSheet.
 * One above RNW's Modal: high enough to win, low enough that a future overlay
 * meant to sit above THIS one still has room without another arms race.
 */
export const ABOVE_SHEET_Z = RNW_MODAL_Z + 1;
