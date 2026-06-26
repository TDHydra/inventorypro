## Task 7: Check In — unit return

**Files:** modify `apps/mobile/app/(app)/(checkin)/index.tsx`. Consumes `getDeployedUnitsForUser`, `setUnitStatus`.

- [ ] **Step 1.** Add a section listing the user's deployed UNITS (`getDeployedUnitsForUser(user.id)`): asset tag + item + job. Select/scan units to return + pick a destination location (`SearchablePicker`). On confirm, for each: `setUnitStatus(u.id,{status:'available', current_location_id: dest.id, current_job_id:null})` + `appendOutbox('INSERT','equipment_units', row)` + `appendLog({action:'checkin', entity_type:'item', entity_id:u.item_id, to_location_id:dest.id, job_id:u.current_job_id, note:'unit '+u.asset_tag, ...})`. Keep the existing count-based job-checkout return section for non-tracked items.
- [ ] **Step 2: tsc** exit 0.
- [ ] **Step 3: commit** `feat(checkin): return tracked equipment units`. (On-device by human.)

---

