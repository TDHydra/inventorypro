MINOR (final-review): SearchablePicker has no onClear; screens use onSelect(currentValue) as clear — add onClear prop or document.
MINOR T6: jobOptions memo dep [step] — stale until step change (cosmetic; selectedJob set immediately).
MINOR T6: PmLocationRow re-queries getLocationsByOwner (harmless double-query).
MINOR T6: qty step lets empty/0 qty advance; caught at confirm not at Next button.
MINOR EU-T7: handleUnitCheckin marked async w/ no await (cosmetic).
MINOR EU-T7: scanNote persists across modal open/close (auto-clears on next input; cosmetic).
MINOR EU-T3: saveEdit writes unit_tracked/tag_prefix for product items too (idempotent, harmless).
