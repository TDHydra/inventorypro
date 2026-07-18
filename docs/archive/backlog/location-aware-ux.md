# Backlog idea: location-aware UX (foreground-only)

*Captured: 2026-06-26 — not yet scheduled.*

## The idea (user's words, paraphrased)
Track the user's **physical** location, but **only while they're actively using the app** (no background tracking — privacy first). Use it to *guide* data entry: nudge them to fill in where they currently are, and — because app locations would be tied to real physical coordinates — let the app pre-guess the **source ("coming from")** or **destination ("going to")** location in Add Stock / Check Out / Check In, so it "already kind of knows" where stock is moving.

## Why it's valuable
- Cuts taps and errors: at the warehouse, "source" pre-selects Warehouse; standing at a van/job, the relevant location is suggested first.
- Reinforces the autofill-everywhere principle already in the app — but driven by *where you physically are* instead of past text entries.

## Sketch of how it could work
- **Foreground-only location** via `expo-location` (`requestForegroundPermissionsAsync` / `getCurrentPositionAsync`). NEVER background tracking. Location is read on-demand when a move screen opens, not continuously logged.
- **Tie app locations to coordinates:** optional `latitude` / `longitude` (+ maybe a radius) on the `locations` row (additive migration, like owner_user_id). A location can be "anchored" to a physical spot when created/edited.
- **Proximity pre-select:** when an Add/Checkout/Checkin screen opens, find the anchored location nearest the device (within radius) and pre-select it as the default source/current location — still fully overridable via the existing `SearchablePicker`.
- **Guidance:** a subtle banner like "You're at **Warehouse** — adding here" with a one-tap change.
- **Privacy/UX:** explicit permission rationale; works fully without the permission (just no pre-selection); no location is ever stored on activity rows unless we later decide to (separate decision).

## Open questions for when this is scheduled
- Do we store the device's reading on activity_log entries (audit "where the move happened"), or only use it ephemerally to pre-select? (Leaning ephemeral-only for privacy.)
- Indoor accuracy: GPS is poor inside a warehouse — may need generous radii or a manual "I'm here" confirm rather than auto-switching.
- Should anchoring coordinates be captured by standing at the location and tapping "use my current spot"?

## Dependencies / fit
- Builds on the existing `locations` + `SearchablePicker` source/destination pickers (Phase 1) — this only changes the *default* selection, not the flows.
- New native module (`expo-location`) → requires a dev-client rebuild (not just a JS reload), so schedule alongside other native additions.
