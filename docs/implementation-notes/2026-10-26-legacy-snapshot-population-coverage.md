# 2026-10-26 — a legacy snapshot's population coverage is UNKNOWN unless observed (#3325)

## Design

A legacy-access snapshot is pulled through a shim the operator writes: a manifest
plus paged rows. A shim that can see one of twelve workstations of a
per-workstation desktop application produces a manifest structurally identical to
one that saw all twelve, so the pull wrote `COMPLETE`, and a recertification over
it attested that every account in scope was reviewed — true of its rows, false of
the application.

Owner decision, 2026-10-09: a snapshot records a whole population only where the
transport can prove it (a single query returning a whole table, with a row count
the pull observed itself). Everything else records UNKNOWN, and the review surface
says "coverage unverified" rather than implying a full population. The
operator-declared expected-source-count option was considered and not taken.

The decision is a SECOND fact on the snapshot, not a new meaning for `status`:

```
LegacyAccessSnapshot.status              PENDING | COMPLETE | PARTIAL   (our read was whole)
LegacyAccessSnapshot.populationCoverage  UNKNOWN | VERIFIED             (the rows are the application)
                                         @default(UNKNOWN) + DEFAULT 'UNKNOWN'
```

`status` gates every reader (invariant 4). Making it UNKNOWN for MCP snapshots
would make every reader refuse every snapshot, and no campaign — and therefore no
"coverage unverified" surface — could exist. So `status` keeps its meaning and
the population claim gets its own column.

```
pull ──(names no coverage; reads it back)──► snapshot row  UNKNOWN by default
                                                 │
createLegacyAccessReview ──freezes──► subject.provenance.populationCoverage
                                                 │
                     frozenCampaignCoverage (allowlist: every subject VERIFIED, ≥1 subject)
                         │                       │                       │
                 campaign page notice    close audit row          evidence PDF
                 "Coverage unverified"   after + summary          "Source snapshot"
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | `LegacyAccessPopulationCoverage { UNKNOWN, VERIFIED }` |
| `prisma/schema/legacy-access.prisma` | `populationCoverage @default(UNKNOWN)` on `LegacyAccessSnapshot` |
| `prisma/migrations/20261026090000_legacy_snapshot_population_coverage/` | `CREATE TYPE` + `ADD COLUMN … NOT NULL DEFAULT 'UNKNOWN'` |
| `src/lib/legacy-access/coverage.ts` | The one reader: `readPopulationCoverage`, `frozenCampaignCoverage` |
| `src/app-layer/usecases/legacy-access-pull.ts` | Leaves the column to the default; reads it back into the audit event and result |
| `src/app-layer/jobs/executor-registry.ts` | Job details carry it beside `status` |
| `src/app-layer/usecases/access-review-legacy.ts` | Freezes it into each subject's provenance and the create audit row |
| `src/app-layer/usecases/access-review-connected.ts` | Close: audit row, evidence-generated row and PDF input, LEGACY_APP only |
| `src/app-layer/reports/pdf/accessReview.ts` | `populationCoverageStatement` under *Source snapshot* |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | The "Coverage unverified" notice |
| `docs/legacy-access-recertification-design.md` | The decision, and the not-taken option |
| `docs/legacy-mcp-access-contract.md` | Tells the operator the contract carries no population claim |

## Decisions

- **The schema default carries the claim, and the pull names no value.** The
  owner's requirement: a default that claimed a whole population with every
  present caller overriding it is one new transport away from regressing
  silently. The default is set in BOTH places that have one, and both are
  tested: Prisma sends its schema default on every client insert (a mutation of
  only the database default left Prisma-written rows UNKNOWN), and the database
  default is what a raw insert and a still-running old container get.
- **Nothing writes VERIFIED.** No transport can observe a whole table: the shim
  runs the query and the manifest's `rowCount` is its own claim. A matching
  `rowCount` is explicitly tested as still UNKNOWN.
- **A label, not a gate.** Refusing UNKNOWN at campaign creation would refuse
  every legacy campaign. The owner chose the label.
- **Read from the frozen subjects, never the snapshot row at close.** The
  subjects are frozen at create; the snapshot row can be purged by retention or
  change. Same reasoning as the payload-hash provenance, and tested by changing
  the row after create.
- **Fail closed in the reader.** VERIFIED only when there is at least one subject
  and every subject says so. A subject frozen before the column existed reads
  UNKNOWN — accurately, since nothing then could verify a snapshot.
- **Keyed on scope, not on provenance.** The PDF and the close render the caveat
  for a LEGACY_APP campaign even if no subject carries readable provenance; a
  CONNECTED_APP campaign gets no coverage key at all, so its rows are unchanged.
- **Not in `computeContentHash`.** That canonical JSON is a published evidence
  contract and extending it changes every issued artefact's hash. The
  hash-chained close row is the tamper-evident copy. The PDF input docblock
  claimed the provenance was in that hash; it was not, and the comment now says so.
- **Not on the reconciliation queue.** The queue claims nothing about a
  population — its empty state says every account *on this run* has an answer.
- **Rolling-deploy safety.** A new type and a defaulted column: old containers
  never select it and their inserts take the default. `NOT NULL` with a constant
  default does not rewrite the table.
