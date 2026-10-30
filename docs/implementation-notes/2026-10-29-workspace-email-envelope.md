# 2026-10-29 — Workspace email follows the workspace's email settings (#4469)

**Commit:** `41d4f5f5b fix(notifications): the digest and scheduled reports follow the workspace's email settings (#4469)`

## Design

The notifications admin page has three email settings: the "Enable email
notifications" switch, the sender name and address, and the compliance mailbox
(BCC). Until this change only `processOutbox` applied them. Two other senders
called `sendEmail` directly, from the deployment sender, with no BCC, and
whether or not the switch was on:

- the weekly compliance digest (`jobs/compliance-digest.ts`)
- scheduled risk-report delivery (`usecases/risk-report.ts::deliverReportByEmail`)

Owner decision (2026-10-29): both follow the workspace's settings, and
invitations always send.

```
                 notifications/settings.ts
   ┌──────────────────────────────────────────────────────┐
   │ tenantEmailEnvelope(settings) → { from, bcc }        │  one definition
   │ resolveTenantEmailEnvelope(db, tenantId)             │
   │   → envelope, or null when email is switched off     │
   └──────────────────────────────────────────────────────┘
        ▲                      ▲                      ▲
   processOutbox          compliance digest     deliverReportByEmail
   (own settings cache,   (checked before any   (checked before the
    own skip on "off")     snapshot query)       artefact is read)

   NOT routed through it — always send, deployment sender, no BCC:
   invite-email.ts · email-verification.ts · password-management.ts
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/notifications/settings.ts` | `tenantEmailEnvelope`, `resolveTenantEmailEnvelope`; the settings update now writes `NOTIFICATION_SETTINGS_UPDATED` |
| `src/app-layer/notifications/processOutbox.ts` | Uses `tenantEmailEnvelope` instead of its own copy |
| `src/app-layer/jobs/compliance-digest.ts` | Skips a switched-off workspace; sends with the envelope |
| `src/app-layer/usecases/risk-report.ts` | Report email skipped when off; sent with the envelope |
| `src/app/api/t/[tenantSlug]/notification-settings/**` | `requirePermission('admin.manage')` on all three verbs |
| `src/app/t/[tenantSlug]/(app)/admin/notifications/page.tsx` | Refused save, failed load, dialog + toast for jobs, saved-state badge, primitives, page text |

## Decisions

- **One helper, not a `sendTenantEmail` wrapper.** A wrapper that also calls
  the mailer would have to live outside `settings.ts`, because that module
  imports nothing at runtime and must not pull nodemailer into the settings
  route. `processOutbox` also cannot use a wrapper: it has its own claim before
  the send and its own settings cache. The shared part is the switch and the
  envelope, so that is what is shared.
- **Only the email is switched off.** A scheduled report is still generated
  and still pushed to SharePoint when email is off. The switch says "email
  notifications", and a SharePoint upload is not email.
- **A failed settings read sends nothing.** `resolveTenantEmailEnvelope`
  throws rather than defaulting to "on, deployment sender". The digest counts
  the tenant as skipped and report delivery counts the run as failed.
- **A manual digest re-run with `recipientOverrides` is governed too.** The
  switch belongs to the workspace, not to whoever started the run.
- **The audit import in `settings.ts` is lazy.** The bell emitters reach this
  module through `isInAppTypeEnabled`, and a static import of the audit writer
  pulled the Prisma client, the encryption extension and BullMQ into their
  import graph. That broke a rendered test that imports the in-app catalogue.
- **The audit row records values.** None of the five fields is a secret, and
  "since when have outbox emails been copied to this address" is the question
  the row exists to answer. A save that changes nothing writes no row.
