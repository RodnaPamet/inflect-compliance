# 2026-09-12 — the leaver pass can be re-run (#2484)

**Commit:** `<sha> feat(jml): an OWNER-gated off-schedule re-run for the leaver pass`

## Design

`runIdentityLeaverPass` had exactly one production caller — the 05:00
`identity-leaver-dispatch` fan-out. That fan-out enqueues with

```
dispatchJobId('identity-leaver-pass', `${tenantId}:${provider}`, DAILY_BUCKET_MS)
```

which is correct for a dispatcher: a retry or a redeploy replaying the schedule
must not mint a second set of journal rows for the same day.

The consequence nobody had a way around is that **re-firing the dispatcher the
same day dedupes to a silent no-op**. BullMQ holds the id in its completed set,
so the second enqueue returns the first job. Nothing errors, nothing is
refused, no row lands on `/admin/identity-leaver-passes` — which from inside
the product is indistinguishable from a dead worker. The read-only
`identity-sync` direction has had a "Sync now" since P1; the direction that
writes to a customer's own directory had nothing, so the safest job was
re-runnable on demand and the most dangerous one was reachable only over SSH.

This adds one endpoint:

```
POST /api/t/:tenantSlug/admin/identity-leaver-passes/run
     Body: { "provider": "entra-id" | "active-directory" }
     202  { status: "queued", jobId, provider }
```

It enqueues **the scheduled job**, with the scheduled payload and the
scheduled `JOB_DEFAULTS` (`attempts: 1` included) — only the dedupe id differs:

```
dispatchJobId('identity-leaver-pass-manual', `${tenantId}:${provider}`, MINUTE_MS)
```

`MINUTE_MS` already existed in `fan-out.ts`, documented as the bucket
"manual-trigger routes" use, and the SharePoint "Sync now" route is the
precedent. The minute bucket is the whole point of the change: a deliberate
re-run must not be swallowed by the dedupe key of the run it is re-running. A
bucket is still used rather than no `jobId`, because two concurrent passes each
mint a journal row per candidate and the second cannot tell its own
predecessor's unsettled row from a genuinely INDETERMINATE write — the same
reason `attempts` is 1. A double-click has to collapse; a click a minute later
must not.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/admin/identity-leaver-passes/run/route.ts` | The endpoint. OWNER-gated, strict body, minute-bucket jobId, audit row, 202. |
| `src/app-layer/integrations/identity-writable-providers.ts` | New leaf module holding `WRITABLE_IDENTITY_PROVIDERS` + `isWritableIdentityProvider`. |
| `src/app-layer/integrations/identity-writer-factory.ts` | Re-exports those three symbols instead of defining them. No behaviour change. |
| `src/lib/security/route-permissions.ts` | An exact-anchored `POST …/run` rule, ordered ahead of the leaver-pass subtree rule. |
| `public/openapi.json` | Regenerated — one new stub path. |
| `tests/unit/identity-leaver-pass-run-route.test.ts` | Authz, the job-id property with its two controls, payload/validation, the audit row, the map. |
| `tests/guardrails/admin-route-coverage.test.ts` | The new route file added to `ADMIN_ONLY_ROUTES`. |
| `tests/guards/regression-scanner.test.ts` | Fifth entry on the `@/lib/prisma`-in-a-route allowlist, with the same reason as the four before it. |

## Decisions

- **OWNER (`admin.tenant_lifecycle`), not ADMIN.** Same key as the write policy
  that decides whether the product may disable accounts at all. Being able to
  fire the pass and being able to authorise the pass are one authority, and the
  role model denies ADMIN `tenant_lifecycle` explicitly.

- **Its own rule in `ROUTE_PERMISSIONS`, ordered before the subtree rule.**
  `^…/admin/identity-leaver-passes(/.*)?$` already matched `/run`, so no new
  rule was strictly needed. But that rule's subject is a REPORT, and an edit
  softening it to `admin.manage` on the grounds that reading is not writing
  would have taken the off-schedule directory write down with it. Two rules
  cost one regex; sharing one costs the gate on the only endpoint in the
  subtree that changes anybody's directory. The test asserts the run path
  resolves through a rule that does NOT match the index path, so a reordering
  fails rather than silently re-inheriting.

- **A distinct job-name prefix, `identity-leaver-pass-manual`.** Only the
  dedupe namespace differs; the enqueued job is still `identity-leaver-pass`,
  deliberately, because a manual run that behaved differently from the nightly
  one would be testing something other than the thing that runs at 05:00.
  Today the arithmetic alone separates a minute bucket from a day bucket (index
  ~1440× larger), but that is arithmetic nobody re-checks when a bucket
  constant changes, and the failure would be the manual run cancelling itself
  against the morning's scheduled one.

- **The provider is required and validated; the CONNECTION is not checked.**
  A pass is scoped to (tenant, provider) and a tenant with both a cloud and an
  on-prem connection has no defensible default, so the operator names the
  directory. The name is checked against `WRITABLE_IDENTITY_PROVIDERS` so a
  typo is a 400 rather than an enqueued pass that refuses
  `UNSUPPORTED_PROVIDER` into an execution row. Everything that depends on
  tenant state — no enabled connection, two of them, a `DISABLED` write policy,
  a tenant still inside its DRY_RUN dwell — is left to the pass, which records
  its own reason. Re-deciding any of that at the edge would be a second
  implementation of the same question, and the two would drift.

- **`WRITABLE_IDENTITY_PROVIDERS` moved to a leaf module.** Importing it from
  `identity-writer-factory` pulls in both provider writers and, through the
  Active Directory provider's index, `undici` — which fails outright under Jest
  (`ReferenceError: File is not defined`) and would ship two directory-writer
  implementations inside a request path that only needs to know whether a
  string names a directory. The alternative, a second hard-coded copy of the
  list at the route, is exactly the drift this repo spends its guards
  preventing: the set that validates and the set that resolves a writer would
  be free to disagree, and the symptom would be a 202 for a directory nothing
  can write to. The factory re-exports all three symbols, so every existing
  importer is untouched and there is still one definition.

- **An audit row at enqueue time, before the worker does anything.**
  `IDENTITY_LEAVER_PASS_REQUESTED` on the Tenant, carrying provider and jobId.
  The pass writes its own execution and journal rows, but only if it is picked
  up; this row is the only trace that a human asked for an off-schedule
  directory write, and it survives a worker that never runs and BullMQ's
  `removeOnComplete` horizon. Modelled on `admin/av-rescan`, the nearest peer.

- **The `@/lib/prisma` import is allowlisted, not routed around.**
  `tests/guards/regression-scanner.test.ts` bans that import from
  `src/app/api/t/**/route.ts`, and it caught this route. The four routes
  already listed — key-rotation, tenant-dek-rotation, sessions, av-rescan — are
  the identical shape, and each carries the identical reason in that file: the
  only mention of prisma is the handle handed to `logEvent`, and no
  `prisma.<model>` query appears in the route. The alternative idiom
  (`runInTenantContext(ctx, (db) => logEvent(db, ctx, …))`, used by the PDF
  report route) would satisfy the scan without an entry, but `logEvent` ignores
  the handle entirely — the insert goes through the global client inside
  `appendAuditEntry` — so that shape opens a transaction that does nothing, in
  order to make a text scan happy. The entry is listed by its full
  `identity-leaver-passes/run` segment rather than by the parent directory, so
  the sibling report route keeps the gate.

- **`API_KEY_CREATE_LIMIT` (5/hr), not the default mutation tier.** Same preset
  as the other OWNER-gated enqueue-a-job routes. A second run on a correct day
  is cheap — `ALREADY_DISABLED` returns before any write and the blast-radius
  breaker sees the same batch — but that is a property of the pass, not a
  licence to fire it in a loop.

- **No GET, and no UI.** The outcome surface is the immediate parent:
  `GET …/admin/identity-leaver-passes` lists every pass with its per-candidate
  decisions, and #2490's journal routes resolve what each write replaced. A
  polling endpoint here would be a third place to read the same run. The button
  itself is a separate change; this ships the mechanism the morning after a
  wrong disable needs.
