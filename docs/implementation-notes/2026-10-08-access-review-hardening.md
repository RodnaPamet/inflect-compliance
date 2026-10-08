# 2026-10-08 — harden the connected access-review flow (Step 5a)

**Commit:** `<pending> feat(access-reviews): audited permission keys on every campaign route (Step 5a.1)` and follow-ups

Step 5a of `docs/legacy-access-recertification-phases.md`. Nothing here is new
capability: the connected access-review flow shipped in PR-7 and this makes it
complete, evidenced and properly authorised **without changing who may do what**.

## The authorisation half

Access reviews were gated by the coarse role-ladder booleans and nothing else —
`assertCanRead` / `assertCanAdmin` inside the usecases. The consequence was not a
hole in who could act; it was that **a refusal left no trace**. Only
`requirePermission` writes an `AUTHZ_DENIED` row, and no access-review route had
one. The surface whose entire output is SOC 2 evidence was the surface that could
not record being refused.

`access_reviews.{view,create,decide,close}` now exists and is enforced at all
eight routes. The grants are derived, not chosen:

```
view    <- canRead   (level >= 1)  all five roles
decide  <- canRead   (level >= 1)  all five roles
create  <- canAdmin  (level >= 4)  OWNER, ADMIN
close   <- canAdmin  (level >= 4)  OWNER, ADMIN
```

### Why `decide` is granted to every role

This is the one grant that looks wrong on sight, and narrowing it would be an
authorisation **regression** wearing the shape of a tightening.

A reviewer is assigned **per campaign** (`AccessReview.reviewerUserId`), so an
EDITOR, AUDITOR or READER can legitimately be the assigned reviewer of a
campaign. The real narrowing is not a role question at all — it is
`!isAssignedReviewer && !canAdmin → forbidden`, which lives in `submitDecision`,
`revokeDecision` and `submitConnectedDecision` because only the usecase can see
*which* campaign is being decided. Granting `decide` to OWNER/ADMIN only would
strip the verb from every non-admin reviewer in the product.

So the key answers "may this role ever record a verdict" and the usecase answers
"is this the person we asked". Both are needed; neither subsumes the other.

### The test is derived from the old mechanism, deliberately

`tests/unit/security/access-review-authz-table.test.ts` does not compare the
grants against a written-down matrix. Two literals in one diff agreeing proves
only that I was consistent, including consistently wrong. It computes the
expectation from `computePermissions` — the function that gated these routes
before this step and which this diff does not touch — and asserts the new key
equals the old boolean, for all five roles and all eight routes. It also carries
a positive control that `canRead` and `canAdmin` actually differ across roles,
because if they did not, the four assertions would pass under any grant table.

### Ordering in `ROUTE_PERMISSIONS` is load-bearing

`resolveRoutePermission` returns the **first** matching rule, and
`^…/access-reviews/[^/]+$` matches `/access-reviews/connected` perfectly well.
The connected CREATE rule therefore has to precede the detail VIEW rule, or a
create silently becomes gated on a read key. There is a test named for exactly
that one failure, because the table test would catch it without anyone reading it
as an ordering bug.

### `requirePermission` and `withValidatedBody` cannot compose

Both claim the third handler argument. The two body-carrying routes moved to
`parseJsonBody` **inside** the handler, which is the sanctioned composition
(`audits/auditors/access/route.ts` documents it) and has the better property:
authorisation runs before the body is parsed.

## Four vacuous passes

The rest of the step is one defect class: **code that returns a correct-looking
answer over an empty or collapsed set.** None of these produced an error anywhere.

### 1. Zero subjects closed as complete

`closeConnectedAccessReview` refused to close while any decision was pending:

```ts
const pending = decisions.filter((d) => d.decision === null);
if (pending.length > 0) throw badRequest(...)
```

An empty campaign has zero pending. So a CONNECTED_APP review with **no subjects
at all** closed instantly, reported `executed: 0`, and would have produced an
evidence artefact attesting that every account in scope had been reviewed —
vacuously true of its rows and false of the directory, which is the only reading
an auditor cares about.

Fixed at both ends: `createConnectedAccessReview` refuses with a machine-readable
`NO_SUBJECTS` (added to `DomainErrorCode`, whose docblock asks for exactly this
kind of discrimination), and the close path refuses `decisions.length === 0` for
the states a create-time refusal cannot cover — a campaign created before the
guard existed, and one whose decisions were removed by a connection cascade.

The code matters because the two causes need different answers: a directory with
nobody in scope, versus a sync that is broken or never ran. The second is both
the common case and the dangerous one, and a bare 400 cannot tell the UI which.

### 2. The same bug in the UI, with a live button

`AccessReviewDetailClient` gated Close on `decided !== decisionsTotal`, counted
over `review.decisions` — the **member** rows. A connected campaign has none of
those, so `decisionsTotal` was 0, `decided` was 0, and `0 !== 0` is false:
**Close was enabled.** The page showed an empty subject table beside a live Close
button, and the only way to see or decide a connected subject was a
`/connected-decisions` endpoint that no page called.

Now `AccessReviewRepository`'s detail include carries `connectedDecisions`, the
page renders them in their own column set, and the gate is
`subjectCount > 0 && decided === subjectCount` — zero is explicitly not complete.

A separate column set rather than a widened row type: a directory account and a
tenant membership share almost no columns. The member table compares snapshot
role against **live** role and shows in-product activity; a directory account has
no membership to compare against and no product activity. What a reviewer needs
instead is who the account belongs to according to HR, whether MFA is on, and
whether the HR link is still believed.

### 3. Two connections collapsed into one subject

`subjectRef` was `${provider}:${email}` against a
`@@unique([accessReviewId, subjectRef])`, inserted with `skipDuplicates: true`.
One tenant may hold several connections for one provider — `IntegrationConnection`
is unique on (tenantId, provider, **name**), so two AD forests or two Entra
tenants are a supported configuration, and `ConnectedIdentityAccount`'s own grain
is `(tenantId, connectionId, externalUserId)`. With the coarser key, the same
person's email in two forests produced one `subjectRef`, the unique constraint
matched, and `skipDuplicates` **dropped the second row silently**. One reviewed
row for two real accounts, and nothing logged.

New reviews use `${connectionId}:${externalUserId}`. Existing rows keep the old
format and stay readable: nothing parses a `subjectRef`, it is displayed, and the
snapshot carries provider and email for that purpose.

### 4. A cap that could not be observed

The snapshot query was `take: MAX_SUBJECTS` (5000). A tenant with a larger
directory got a campaign over the first 5000 accounts and **no indication
anywhere** that the rest existed — then closed it as complete.

`take: N` returning exactly N cannot be distinguished from a directory of exactly
N accounts, so the query now reads `MAX_SUBJECTS + 1` and the extra row is the
witness. The verdict persists as `AccessReview.snapshotTruncated`, surfaces as a
banner on the page the operator closes from, prefixes the PDF's description, and
travels in the hash-chained close audit row.

Not retroactive: whether any pre-existing row was truncated is not knowable now,
and asserting either answer over those rows would be inventing evidence.
Production holds 0 CONNECTED_APP campaigns as of 2026-10-08, so the unknowable
set is empty in fact.

## The evidence artefact

`closeConnectedAccessReview` produced **no PDF at all** — `generateAccessReviewPdf`
had exactly one caller, the member close path.

It now produces one, and the close is split into two phases to do it. Phase 1 is
the transaction: guards, the conditional close claim, remediation tasks, executed
stamps, the close audit row. Phase 2 runs after it commits: render, hash, store,
attach. `runInTenantContext` **is** a `$transaction`, so rendering and uploading
inside it would hold a tenant-scoped transaction open for the length of an upload,
and a storage timeout would roll back a close the operator was told had happened.
Phase 2 is wrapped in a catch that logs and continues, so a failed artefact leaves
a CLOSED campaign with a null evidence link rather than an un-closed campaign —
the same trade the member flow already makes.

A close that loses the TOCTOU race writes no artefact: the winner is producing it,
and one campaign gets one evidence file.

### Two contract details

`AccessReviewPdfDecisionRow` typed `snapshotRole: Role` and
`snapshotMembershipStatus: MembershipStatus`. A connected subject has neither —
it was never a member of the tenant. Both fields are used only as display strings
and hash inputs, never compared against enum members, so they now accept
`DirectorySnapshotRole` (`DIRECTORY_ADMIN` | `DIRECTORY_USER`) and
`DirectorySnapshotStatus` (`MFA_ENROLLED` | `MFA_MISSING`) alongside the enums.
Literal unions rather than widening to `string`: the member flow keeps its typing
and the connected claims stay closed.

`computeContentHash` is **not** extended to cover `snapshotTruncated`. That
canonical JSON is a published evidence contract; adding a field changes the hash
of every artefact ever generated and invalidates exactly the verification it
exists to support. The truncation verdict goes in the rendered description, which
an auditor reads, and in the hash-chained audit row, which is the tamper-evident
copy — and the chain is the stronger guarantee anyway.

Connected notes **are** rendered, unlike the member flow's. The member column is
encrypted, which is why its PDF is metadata-only; the connected column is plain
text written through `sanitizePlainText`. It is sanitised again on the way into
the PDF, because a row written before that sanitisation existed would otherwise
reach the artefact unfiltered, and a PDF is the one output nobody re-reads before
an auditor does.

## Two jobs that were inert

`access-review-reminder.ts` and `access-review-overdue-escalation.ts` both counted
`review.decisions` only. A CONNECTED_APP campaign has zero member rows, so
`pendingCount === 0`, which both jobs read as "every subject decided" — the
reminder classified it `skippedComplete` and the escalation recorded that every
reviewer slot had a verdict.

So a connected campaign with 300 undecided accounts and a due date tomorrow was
nudged **exactly never**, and an overdue untouched one never escalated to an
admin, each while incrementing a counter that said it had been skipped for being
finished. Both now sum the two populations. Summed rather than branched on
`scope`: there is no scope value to forget, and the arithmetic stays correct if a
campaign ever carries both kinds of subject.

## HR context

Each connected subject's snapshot now carries the linked employee, employment
status, department, job title and manager, read from `IdentityAccountLink` —
`findMany` only, in one query for the whole snapshot rather than per subject. The
Step 0a guard (#3247) asserts at source level that this module is not a writer of
the directory identity tables; the test here asserts it at runtime, by checking
the mock exposes nothing but `findMany`.

`hr: null` is recorded explicitly for an unlinked account rather than omitting the
key. An unlinked account is a **reviewable fact** — a service account, a
contractor the HR feed does not carry, or an unreconciled one — and an absent key
would read as "nobody looked". A link a later sync observed to be *contradicted*
is surfaced as such, so stale HR context is not read as current.

## Deliberately not done here

`revokeDecision` is complete, gated, audited and tested, and **unreachable** — no
route exports it, so the reviewer flow its docblock describes cannot start. Filed
as #3269 rather than folded in, because Step 5a does not mention revoke. A revoke
route should carry `access_reviews.decide`: revoking is the same authority as
recording, and the identical assigned-reviewer rule already sits in the usecase.

`collectPdfBuffer` had four private copies before this step needed a fifth. The
two access-review usecases now share `reports/pdf/collect-buffer.ts`; the three
route-level copies are untouched, because migrating them is unrelated to an
authorisation step and would widen this diff into a refactor.
