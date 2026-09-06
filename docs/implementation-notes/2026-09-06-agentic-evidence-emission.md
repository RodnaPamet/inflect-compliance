# 2026-09-06 — Receipts and decision records become evidence artefacts

**Commit:** _(this PR)_ `feat(agentic): emit verified receipts and decision records as evidence`

## Why

Nine prompts of agentic governance produced RECORDS: mediator-signed action
receipts, a hash-chained audit trail, one `AiDecisionLog` row per AI invocation,
kill-switch drills, policy cards, tool-manifest pins. None of that is EVIDENCE
until it is attached to the control it discharges — and until this change, that
attachment was a person with a spreadsheet in the week before an audit. The
premise the roadmap was built toward is that an assessor asks "show me your agent
governance" and the answer is a generated report, not a project.

## Design

```
AgentActionReceipt (verified + auditLogId)  ─┐
AiDecisionLog      (digest + bounded summary)─┤
                                             │  emitAgenticEvidence(ctx, {asOf})
                                             ▼
                        EVIDENCE_TARGETS  (kind → framework family + requirement code)
                                             │
                       Framework FAMILY expansion (sourceUrn, not key)
                                             ▼
                        ControlRequirementLink → the tenant's agentic Controls
                                             ▼
        Evidence(TEXT, category 'integration') + EvidenceControlLink
                                             ▲
                        AgenticEvidenceArtefact  ── the identity + the digest
```

### The identity is `(tenant, control, kind, period)`

This is the load-bearing choice, and both obvious alternatives are wrong in
opposite directions.

- **A receipt id** gives one evidence row per agent action. That is not an
  artefact; it is a second copy of the receipt ledger on a wider read surface,
  unbounded in size, in front of a human who asked one question. Re-running is
  "safe" only because every row is new.
- **A content digest** makes re-running safe exactly while nothing changes.
  Receipts arrive continuously, so the first new receipt inside an open month
  moves the digest and August acquires a SECOND artefact — duplication by
  construction, and two artefacts for one month that nobody can rank.
- **`(control, kind, period)`** is the unit the question is asked in. Re-running
  recomputes the same identity and updates in place. The population digest
  survives as a FIELD, so "did anything move" stays answerable without
  multiplying rows.

It is a UNIQUE INDEX rather than a read-then-write, because two overlapping ticks
would otherwise both read "absent" and both insert. The loser catches P2002, and
because each artefact is written in its own transaction, the `Evidence` row it
had just created rolls back with it rather than being orphaned.

The period is the UTC month CONTAINING the run, not the last complete one — so
an assessor looking today sees today's evidence. That is only affordable because
the identity is not the digest.

### What an artefact must NOT contain

`AiDecisionLog` stores a digest instead of the prompt and a bounded, sanitised
summary instead of the output. `AgentActionReceipt.scannedSummary` is bounded and
scrubbed rather than the mediated payload. Both are deliberate — and
`Evidence.content` is a strictly WIDER surface than either: it is *not* in the
field-encryption manifest (it is searched through `EvidenceRepository`), it is
rendered into PDF exports, and it is reachable through an audit-pack share link.
An artefact that inlined what those two excluded would move the excluded content
to the place with the largest blast radius and undo both decisions at once.

The rule is enforced by the SHAPE of the input rather than by a reviewer
remembering it. `ReceiptFact` and `DecisionFact` in
`src/lib/agentic/evidence-artefact.ts` are the complete set of fields an artefact
may render; neither carries `scannedSummary`, `signature`, `inputDigest` or
`outputSummary`, and the emitter does not even SELECT those columns. Widening
either interface is the decision to publish another field, and it has to be made
on purpose. The behavioural proof is a canary planted in both source records and
asserted absent from every emitted row.

The artefact carries counts, closed vocabulary (verdicts, human outcomes, tool
names from our own catalogue), the population digest, and a REDACTION CONTRACT
paragraph saying what is deliberately absent and where to get it — because the
reader is an assessor, and an honest redaction that is not declared reads as an
incomplete export.

### Withdrawal: neither deleting nor leaving stale

Two things can make an artefact's basis stop holding: a control is uninstalled,
or the records it counted turn out not to be verifiable. Both obvious responses
are wrong, in different ways. DELETING the evidence destroys something an audit
pack may already cite — the shape of evidence tampering, and the exact behaviour
a hash-chained trail exists to make impossible elsewhere. LEAVING IT STALE lets a
removed control go on advertising coverage it no longer has.

So the row is kept and told the truth. The artefact moves to
`status = 'WITHDRAWN'` with a dated reason and its `Evidence` is ARCHIVED with a
withdrawal notice in place of the counts. A CHECK constraint pairs the status
with the reason, because a withdrawn artefact that does not say why is
indistinguishable from an emitter that died — which is the ambiguity the ledger
exists to remove.

The ORDINARY case never reaches withdrawal: a receipt found unverifiable simply
drops out of the next re-emission, the counts recompute, and the same artefact
goes on being true. Withdrawal is for when the basis is gone entirely.
Un-withdrawal is symmetric — a control whose removal is undone resumes into the
SAME row, because a second August artefact would mean the notice and the live
counts both stood.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `AgenticEvidenceArtefact` — the identity, the digest, the withdrawal record |
| `prisma/migrations/20260906150000_agentic_evidence_artefact/migration.sql` | Table + CHECKs + identity unique index + the RLS triple with FORCE |
| `src/lib/agentic/evidence-artefact.ts` | Pure: kinds, `EVIDENCE_TARGETS`, period arithmetic, population digest, the body builders and the field-shape rule |
| `src/app-layer/usecases/agentic-evidence-emission.ts` | `emitAgenticEvidence` + `withdrawStaleAgenticEvidence` |
| `src/app-layer/jobs/agentic-evidence-emission.ts` | The daily sweep over tenants holding a live agentic control |
| `src/app-layer/jobs/{types,schedules,executor-registry}.ts` | Payload type, `JOB_DEFAULTS`, 06:30 UTC schedule, executor registration |
| `tests/integration/agent-receipt-chain-integrity.test.ts` | The keystone — `verified` is trustworthy, and the link does not break the chain it joins |
| `tests/integration/agentic-evidence-emission.test.ts` | Attachment, idempotency, the Art 12 artefact, the redaction canary, withdrawal |
| `tests/integration/agentic-evidence-isolation.test.ts` | Two tenants over one shared framework row, plus the RLS layer |
| `docs/data-retention.md`, `tests/guardrails/{tenant-isolation-forward-lock,schema-index-coverage}.test.ts` | Classification + triage entries the new model requires |

## Decisions

- **The framework is resolved as a FAMILY, not a key.** Every framework here
  exists in up to two `Framework` rows with different `key` values (the seed's
  `OWASP-ASI`, the library's `OWASP-ASI-TOP10`) and a tenant's controls hang off
  whichever its database got. A single-key lookup emits nothing for half the
  estate, and the failure is indistinguishable from a tenant with no agentic
  controls. The isolation test creates its framework with a key of its OWN and
  the shipped `sourceUrn`, so a key-matching implementation fails it.
- **The kind → obligation map is declared, not inferred.** "Which risk does this
  receipt evidence" is a compliance judgement. A heuristic would put a claim in
  front of an assessor that nobody made. `EVIDENCE_TARGETS` is four entries, each
  with a written reason: receipts evidence ASI02 (every tool call mediated) and
  ASI04 (each receipt stamped with the tool provenance in force); decision
  records evidence ASI09 (the accept-without-change rate is the measurable form
  of automation bias) and EU AI Act Art 12 (the log IS the record).
- **Zero-count artefacts are emitted.** "This control produced no agentic
  activity in August" is a finding an assessor wants, and an absent row is
  ambiguous between no activity and no emitter.
- **Unverified receipts are counted, and reported as unverified.** Dropping them
  would hide the fact that a mediator's signature failed — the fact most worth
  surfacing. Only `verified && auditLogId !== null` is reported as an attested
  action, and the emitter checks BOTH even though `ingestReceipt` cannot produce
  a disagreement, because an artefact that inherited a broken invariant would
  launder it into a compliance claim.
- **`kind` / `status` / `withdrawnReason` are TEXT + CHECK, not Postgres enums.**
  The `@@map("WorkItem*")` lesson: an `ALTER TYPE` mid-rolling-deploy makes
  still-running old containers fail with SQLSTATE 42704, and all three
  vocabularies are ones a follow-up will widen.
- **`lastEmittedAt` is separate from `updatedAt`.** An unchanged population moves
  only the former, so "the emitter is alive" and "the evidence changed" stay
  separable — an operator asking the first question should not have to infer it
  from the second.
- **Emission and withdrawal run in ONE job.** They are the same question asked
  both ways: which controls should have evidence this month, and which artefacts
  have lost the control they were about. Two jobs would let one run without the
  other and leave a control's evidence page telling two different stories.
- **`AiDecisionLog`'s first `findMany` in `src/app-layer` lands here**, which is
  why it appears in `LIST_MODELS_TENANT_INDEX_SUFFICIENT` in this diff even
  though the model is old. Its `@@index([tenantId, createdAt])` is exactly the
  shape the period range and the sort want.
