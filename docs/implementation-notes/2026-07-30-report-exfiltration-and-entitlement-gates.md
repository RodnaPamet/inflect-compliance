# 2026-07-30 — Scheduled-report exfiltration, SharePoint push targets, and the PDF paywall

**Commit:** `<sha>` fix(reports): close the scheduled-delivery exfiltration channel, validate SharePoint targets, enforce the PDF entitlement

Prompt 1 of a three-part audit of the report surface. Six findings; four needed
code, one was already closed, one folded into another.

| Finding | Outcome |
|---|---|
| R1.1 scheduled delivery is an unguarded exfiltration channel | Fixed — three defects, two new columns, one new permission |
| R1.2 SharePoint push target unvalidated + `isEnabled` fail-open | Fixed |
| R1.3 PDF paywall bypass, two routes | Fixed — both real |
| R1.4 `reports.export` enforced nowhere | **Already fixed** in #1697. Verified only. |
| R1.5 `assertTenantKey` on artefact reads | Fixed, plus streaming and the attachment cap |
| R1.6 verify `templateId` on schedule create | Fixed (in the same function as R1.1) |

## R1.1 — the interesting part was picking the right two gates

Three defects composed into one attack: an EDITOR could point the tenant's
portfolio-risk PDF at an address they controlled, weekly, forever, executed with
owner privileges and logged against the owner.

**Why two gates rather than one.** The obvious fix is "require admin to create a
schedule". That would have closed the hole and broken a legitimate flow: a writer
mailing a report to colleagues is the ordinary case, and making every schedule an
admin action pushes users to forward PDFs by hand — strictly worse than a
reviewed destination. The equally obvious alternative, "recipients must be tenant
members", refuses external auditors, which is a real and common GRC need.

So the destination and the authority are separated:

1. **Every recipient must resolve** — an ACTIVE member, or an entry in the
   tenant's new `reportRecipientAllowlistJson`. Anything else is refused *by
   name*, because the caller supplied the address and echoing it back leaks
   nothing.
2. **Aiming off-tenant is the elevation** — any non-member recipient requires the
   new `reports.schedule_external` permission (OWNER/ADMIN).

Approving a destination and using one are now different acts by different people:
the allowlist lives on `TenantSecuritySettings`, an admin surface.

Both gates are enforced on the **edit** path too. Gating only create would let a
writer save an innocuous schedule and re-point it afterwards.

**Attribution.** `ReportSchedule.createdByUserId` is new, and the delivery cron
no longer looks up an admin at all — it runs as a fixed synthetic principal
(`system:report-delivery`) with explicitly narrowed permissions and passes the
schedule's author into `ReportRun.requestedBy` via a new `generateReport` option.
Stating the cron's permissions explicitly rather than deriving them from a role
matters: granting it a role's full sheet would recreate the borrowed-authority
problem in a new shape. It cannot act as admin, and it cannot widen a schedule's
own destination.

That change also removes a bug from prompt 2 (R2.6) at the root. The old
`buildCtx` returned null when a tenant had no active owner or admin, and the loop
`continue`d **before** advancing `nextRunAt` — so those schedules stayed
`lte: now` and were re-selected in the `take: 1000` window on every daily run,
forever. With no admin lookup there is no null branch. The test that asserted
that behaviour has been inverted.

**No backfill.** The migration adds both columns nullable and stops. The
authorship of existing schedules was never recorded anywhere, and defaulting it
to the tenant owner would write exactly the fiction the column exists to end.

## R1.2 — enforce the allowlist in the direction that can't be spoofed

`allowedSiteIds` is a list of **sites**; every drive write takes a **drive id**.
Nothing mapped between the two, so the allowlist was consulted only by
`testConnection` and `listSites` and enforced on **zero** drive operations.

Two ways to close it. Read a `siteId` off the drive resource and compare — which
trusts a field on the object being validated, the wrong direction of trust for an
authorization check. Or resolve the drives **of the approved sites** and check
membership: a positive allowlist, where an id that is not in an approved site's
drives simply is not in the set. The second, via the `listDrives(siteId)` the
client already had.

It fails **closed** on an empty allowlist. "The admin has not approved any sites
yet" and "every site is fine" are opposite statements, and the previous code
effectively read the first as the second.

`isEnabled` was in `loadConnection`'s `select` and in no `where` and no call
site's condition, so a DISABLED integration still authenticated and still
received pushed reports. Disabling an integration has to mean it stops working; a
flag that only changes how a row renders is not a control. The delivery path also
took `connections[0]`, which under `orderBy: createdAt desc` is the *newest* — not
documented, not stable across a re-connect. Now: filter on `isEnabled`, take the
oldest.

## R1.3 — both bypasses were real, and CSV deliberately is not gated

`reports/pdf/generate` has enforced `PDF_EXPORTS` since #1697. The risk-report
engine never did, so Portfolio Summary, Deep Dive and BIA were free — while the
hub rendered a locked, `pointer-events-none` PDF button for a FREE tenant, one
click from a route that minted unlimited documents. A paywall enforced only in
the client is not a paywall.

**CSV is left ungated on purpose.** It is a data extract rather than a rendered
artefact, `PDF_EXPORTS` is the flag that exists, and the hub does not gate CSV
either — it renders that button inside `{isIso && …}`, not inside an
`UpgradeGate`. Gating it here would invent an entitlement the product does not
sell.

The SoA print view had `getTenantCtx` and nothing else, so any member — READER
included — could open it and `window.print()` a full Statement of Applicability.
It now redirects unless the caller has `reports.export` **and** the entitlement.
Redirect rather than throw because it is a page: someone who arrives without the
grant should land somewhere useful.

## R1.5 — the guard was impossible to write, not merely absent

`readReportArtefact` took a bare `outputPath` with no ctx. That is worse than a
missing check: there was nothing to compare against, so no reviewer could have
added one without changing the signature. Safe today only because `outputPath` is
always produced by `generatePathKey(ctx.tenantId, …)` and the row is read
tenant-scoped — properties of the *callers*, not of the read.

Split into `openReportArtefact` (asserts, returns the stream) and
`readReportArtefact` (asserts, buffers) so the two genuinely different needs —
streaming to a client versus sizing an email attachment — are visible at each
call site.

## R1.4 — verified, not written

`reports.export` is enforced via `requirePermission` on all three routes the
finding names, and registered in `route-permissions.ts`. Landed in #1697 on
2026-07-24. The claim "grep finds zero enforcement anywhere in the codebase" was
false when the audit was written.

## Decisions

- **`reports.schedule_external` is a new PermissionSet key, not a reuse of
  `admin.manage`.** The repo's convention is typed dotted keys, and the
  distinction is real: a one-off export hands data to the person who asked and is
  bounded by their session; a schedule is a standing feed that keeps sending
  after that person loses access.

- **A required audit discriminator caught a would-be outage.** The new
  `REPORT_DOWNLOADED` event initially omitted `category`, which
  `validateAuditDetailsJson` rejects — and since the `logEvent` is awaited before
  the response, every download would have 400'd. `tsc` was happy. Found by
  asserting the payload against the real validator rather than a mock, which is
  the second time this exact shape has bitten.

- **Two tests asserted the defects and were inverted** — the delivery job's
  "skips schedules whose tenant has no admin (no generate, no update)", which
  pinned the starvation, and a SharePoint fixture with no `isEnabled`, which now
  correctly reads as not-enabled.

- **Every gate is mutation-proved independently**: accepting any recipient fails
  5 tests, dropping the elevation fails 2, removing the cap fails 2, and
  restoring a borrowed admin identity fails 1.
