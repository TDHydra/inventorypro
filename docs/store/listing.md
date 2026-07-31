# Play Store listing — InventoryPro

Drafts for the Play Console store listing. Assets in this folder:
`play-icon-512.png`, `feature-graphic-1024x500.png`. Screenshots: capture ≥2
phone screenshots (1080×1920 or device-native) from a release build.

## App name (30 chars max)
InventoryPro

## Short description (80 chars max)
Inventory, jobs, vehicles & crew chat for your team — offline-first, auto-sync.

## Full description (4000 chars max)
InventoryPro keeps your crew, inventory, and jobs in sync — even when the job
site has no signal.

Built for field teams, InventoryPro works fully offline and syncs automatically
whenever a connection is available, so everyone sees the same stock counts, job
records, and updates without double entry.

FEATURES

• Inventory tracking — items, quantities, units, and locations, organized the
way your shop actually works, with shelf/location pickers and quick add.
• Jobs — create and manage jobs, assign teams, and keep job history in one place.
• Vehicles & equipment — service records, tank levels, and gas receipts.
• Photos & receipts — attach camera photos to records for documentation.
• Team chat & notifications — built-in messaging with push notifications for
the updates that matter.
• Offline-first — every feature works without a connection; changes queue and
sync automatically when you're back online.
• Role-based access — admins control who can see and change what.
• Audit trail — changes are logged so you always know who did what.

InventoryPro is designed for provisioned company accounts: your administrator
creates your login, and your data stays on your company's own server — no ads,
no third-party tracking, no data selling.

## Category
Business

## Contact details
- Email: matt@mattinfo.com
- Privacy policy URL: https://invenpro.app/privacy  (serve docs/store/privacy.html — see below)

## Data safety form answers
- Collects data: YES. Shares data: NO.
- Data types collected (all "required for app functionality", encrypted in transit,
  users can request deletion):
  - Personal info → Name: collected (account provisioning)
  - Photos and videos → Photos: collected (user-attached media)
  - Location → Approximate location: collected (job-site context, foreground only)
  - App activity → App interactions: collected (audit log)
  - Device or other IDs: collected (push token)
- Data deletion: users can request account + data deletion (privacy policy contact).
- Independent security review: No. Data encrypted in transit: Yes.

## Content rating questionnaire (IARC)
- Category: Utility/Productivity/Business. No violence, no sexual content, no
  gambling, no user-generated public content (chat is private/company-internal —
  answer the "users can interact" question YES → "communication with known users"),
  no location shared with other users publicly. Expected rating: Everyone / PEGI 3.

## App access (review requirement)
App requires provisioned login → provide Google reviewers a demo account:
create a low-privilege demo user + PIN in the admin screen and enter it under
"App access" in Play Console. Point it at production API.

## Target audience
18+ (workplace tool). Not directed at children.

## Serving the privacy policy (no code deploy needed)
Copy the static file to the VPS and add an nginx location on the host edge:

```bash
scp docs/store/privacy.html pmshydra@192.168.1.72:/tmp/privacy.html
ssh -t pmshydra@192.168.1.72 'sudo mkdir -p /var/www/invenpro-static && sudo mv /tmp/privacy.html /var/www/invenpro-static/privacy.html'
# then in the invenpro.app server block (host nginx):
#   location = /privacy { root /var/www/invenpro-static; try_files /privacy.html =404; }
ssh -t pmshydra@192.168.1.72 'sudo nginx -t && sudo systemctl reload nginx'
```
