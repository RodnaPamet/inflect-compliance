# 2026-10-18 — access-review purge retention, and two LEGACY_APP fixes

**Commit:** `fix(access-review): retain campaigns across a tenant purge; route LEGACY_APP subjects and evidence controls correctly (#3716, #3724)`

Three defects from #3716, none introduced by 3a (#3674). #3724 is a duplicate of
the first plus a request for a structural guard.

## Design

### 1. A tenant purge kept nothing of an access-review campaign

```
TENANT_PURGE_RETAINED (before)        FK                          purge
─────────────────────────────         ─────────────────────────   ─────────────────────────
AccessReviewConnectedDecision  ──┐
AccessReviewAgentPack          ──┼──  ON DELETE CASCADE  ──►  AccessReview  ◄── DELETE … WHERE tenantId
AccessReviewAgentNarrowing     ──┤    (every one)              (NOT retained)
AccessReviewDecisionSampleAudit──┘
```

`TENANT_PURGE_RETAINED` is a list of tables the purge does not name in a
`DELETE`. Not naming a table does not keep its rows: Postgres runs a child's
`ON DELETE CASCADE` when the parent goes, whatever the list says. The four
evidence tables were retained; their campaign root was not; so the campaign
DELETE removed them all, in a run that reported success.

**Owner decision, 2026-10-18: retain the evidence.** The mechanism is the one
`AuditLog` already uses — membership of the retained set — extended to the
root: `AccessReview` and `AccessReviewDecision` (the member-decision table, the
last child left) join `TENANT_PURGE_RETAINED`, and the retention doc classes
both as Regulatory artefacts, which the two-sided
`tenant-purge-retains-regulatory` guard requires.

Nothing else had to be retained for a campaign to stay readable, and no
migration was needed — every FK from the campaign family to a purged table was
already a column-scoped `SET NULL`:

| Retained row | Points at (purged) | Action today |
| --- | --- | --- |
| `AccessReview.evidenceFileRecordId` | `FileRecord` | `SET NULL ("evidenceFileRecordId")` |
| `AccessReviewDecision.membershipId` | `TenantMembership` | `SET NULL ("membershipId")` |
| `AccessReviewConnectedDecision.connectedAccountId` | `ConnectedIdentityAccount` | `SET NULL ("connectedAccountId")` |

Reviewer, creator, closer, subject and decider are global `User` rows. The purge
deletes no `User` — `User` has no `tenantId` — so those references stay valid,
as `AuditLog.userId` does. The three `SET NULL`s are UPDATEs, and only one
lands on a table with a one-way trigger: `access_review_connected_decision_one_way`
already permits `connectedAccountId` moving to NULL (a mid-review deprovision
needs the same), and the integration test exercises it.

### 2. The LEGACY_APP detail page showed no subjects

`AccessReviewDetailClient` chose its subject table with
`scope === 'CONNECTED_APP'`. A LEGACY_APP campaign's subjects are
`AccessReviewConnectedDecision` rows, so it fell through to the member roster,
which is always empty for it. The branch now asks `subjectTableOf(scope)`
(3a deploy 1's `SUBJECT_TABLE`), with AGENT still branched on first.

Routing alone would have rendered every legacy row as "Directory user · MFA not
enrolled": the connected posture cell reads `isAdmin` and `mfaEnrolled`, which a
legacy snapshot does not carry. A legacy row now shows the application's own
privilege flag (`isPrivileged`), unknown when the application did not report
one, and no MFA line.

### 3. The legacy evidence controls never resolved

`LEGACY_EVIDENCE_REQUIREMENTS` keyed on `framework.key = 'iso27001'` /
`code = 'A.5.18'` and `nis2` / `Art. 21(2)(i)`. The deploy-time catalogue seeds
`ISO27001` / `5.18` and `NIS2` / `Art.21(2)(i)`. Its integration test seeded its
own rows under the module's spellings, so the two agreed with each other and
with no real database. Resolution now follows the agent campaign's
`resolveEvidenceControls`: family (`frameworkFamilyId`, or a listed key) picks
the framework rows, `requirementCodeSpellings` picks the code, and results
dedupe on `(control, family, canonical code)`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/tenant-purge.ts` | `AccessReview` and `AccessReviewDecision` join `TENANT_PURGE_RETAINED` |
| `docs/data-retention.md` | both reclassified Regulatory; the four evidence rows corrected; new "Tenant purge" subsection; open question 10 |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | subject table via `subjectTableOf`; legacy posture cell |
| `messages/en.json`, `messages/bg.json` | `appPrivileged`, `appStandard` |
| `src/app-layer/usecases/legacy-evidence-controls.ts` | obligations by family + spelling |
| `src/app-layer/usecases/access-review-connected.ts` | the close de-duplicates suggested control ids before filing |
| `tests/integration/legacy-access-review.test.ts` | a LEGACY_APP close files its evidence against the seed-mapped control, once |
| `tests/integration/tenant-purge-retains-access-reviews.test.ts` | the real purge over four closed campaigns, two tenants, exact survivors |
| `tests/integration/legacy-evidence-controls.test.ts` | rewritten against the catalogue the deploy seeder applies |
| `tests/rendered/access-review-detail.test.tsx` | a LEGACY_APP campaign renders its subjects |
| `tests/unit/tenant-purge.test.ts` | the campaign family is retained; dead citation corrected |
| `CLAUDE.md` | Data Retention: a skipped table does not keep a cascaded row |

## Decisions

- **Retain the root, not detach the children.** #3724 offered both. Detaching
  would mean making four NOT NULL FKs nullable, a denormalised campaign
  reference on each, and amending three one-way triggers that refuse every
  UPDATE — all to keep children whose parent is the record an auditor opens
  first. Retaining the parent is a two-line change to a set, the mechanism
  `AuditLog` already uses, and needs no migration.
- **The evidence PDF's `FileRecord` is not retained.** It is a Business record
  in a table the purge empties, and the retained set is per table, not per row.
  The pointer is nulled; the decisions it rendered are retained, so the
  evidence can be re-derived from them. The stored object itself is untouched:
  the purge deletes rows, never storage objects.
- **The integration test is the purge's first real-database test.** The unit
  test's docblock pointed at a `tenant-purge-live.test.ts` that never existed;
  it now points at this one.
- **"Exactly what is left" is read from the catalogue.** The survivors
  assertion counts every `tenantId` table in `information_schema`, so a row
  that should have gone and stayed fails as surely as one that should have
  stayed and went. The second tenant is compared row-for-row as `to_jsonb`.
- **NIS2 resolves on its seeded representation only.** The library imports the
  same obligation as `NIS2-HR`, a separate code namespace;
  `domain/framework-representation.ts` reconciles only ISO 27001's `A.` prefix,
  and teaching it NIS2 is a change to every consumer, not to this one.
- **The close counts a control once.** The suggestion lists a control per
  obligation, so a control mapped to A.5.18 and CC6.1 appears twice; the
  close's `createMany` already skipped duplicates, but its audit row reported
  `requested: 2, linked: 1`, which reads as a failed link. It never showed
  while the suggestion matched nothing; it does now, so the ids are
  de-duplicated where the close reads them.
- **A soft-deleted control is no longer suggested.** The old query omitted
  `control.deletedAt: null`; the emitter's reason for it — a removed control
  must not keep attracting evidence — applies here unchanged.

### The #3724 guard is held, and why

The structural guard #3724 asks for — no retained model may cascade,
transitively, from a model the purge deletes, derived from the live schema and
the purge's own deleted set, no allowlist — was written and mutation-checked. It
is green for the whole access-review family and RED on five other retained
models, each of which cascades from a business record the purge deletes:

```
AgentPolicyCardVersion.card        <- cascade from AgentPolicyCard
AgentProposalApproval.proposal     <- cascade from AgentProposal
AgentProposalSampleAudit.proposal  <- cascade from AgentProposal
AgenticEvidenceArtefact.control    <- cascade from Control   (also Evidence, RegisteredAgent)
IncidentEvidence.evidence          <- cascade from Evidence
```

The 2026-10-18 decision covers access reviews; each of these needs its own
answer (retain the parent, detach the FK — a migration and, for the
append-only tables, a trigger change — or stop classing it as retained). An
allowlist is what the brief forbids, so the guard is kept off this commit until
those five are decided rather than landed red or landed with exemptions. The
retention doc states the current behaviour of all five and records the question
as open question 10.
