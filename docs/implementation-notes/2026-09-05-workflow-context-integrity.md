# 2026-09-05 — Workflow context integrity (OWASP ASI06)

**Commit:** `feat(agentic): seal, chain and bound the workflow run context` (branch `feat/agentic-6b`)

## Design

`WorkflowRun.contextJson` is the agentic engine's memory. It accumulates across
steps, survives a `HUMAN_CHECKPOINT` pause of arbitrary length, and every later
step takes its instructions out of it — `args(context)`, `buildItems(context)`,
`synthesize(context)`. So a value that gets in once shapes behaviour long after
the interaction that produced it. That is OWASP ASI06 (Memory and Context
Poisoning), and before this change nothing in the product could have detected
it.

The column is in the Epic B encryption manifest, and that is the trap worth
naming: **encryption is confidentiality, not integrity.** It says nobody read
the context. It says nothing about whether the context is the one the previous
step wrote.

Three properties now hold, all enforced in `src/lib/agentic/context-integrity.ts`
and wired at the two seams in `src/app-layer/usecases/workflow-runs.ts`.

**1. A schema, checked on every read and every write.** The persisted shape is
an envelope — `{ v, seq, prev, input, outputs }` — parsed by a `.strict()` zod
schema. `.strict()` is load-bearing: an unknown top-level key is a blob this
engine did not write, and accepting it would let a writer smuggle state past a
schema that claims to describe the whole envelope. Validating on WRITE as well
as read means a step callback that puts something unrepresentable into `outputs`
fails at the step that did it, not at whichever later step happens to read it
back.

**2. A hash chain, shaped like the audit trail's.** This is the same
construction as `src/lib/audit/canonical-hash.ts`, using that module's own
`canonicalJsonStringify` — not a second chaining scheme:

```
hash_n = SHA-256(canonicalJSON({ contextDigest, previousHash: hash_n-1,
                                 runId, seq: n, tenantId, version }))
```

`hash_n` goes to the new `WorkflowRun.contextHash` column in the same statement
that writes the context. `runId` and `tenantId` are in the payload, so a context
lifted from another run — or another tenant's run — is not a well-formed link
here. `seq` is in the payload, so REPLAYING an earlier, genuinely-sealed context
from this same run is caught too: it was a valid link at seq 3 and is not one at
seq 7. That is the "stale" half of the threat, and it is why the chain does more
than a plain checksum would.

**3. A size cap that halts.** `MAX_CONTEXT_BYTES` (256 KiB) bounds what a single
persisted context may WEIGH. `ENGINE_CAPS` already bounds what a run may SPEND
(steps, tokens, wall clock) and those are different failures — a run can sit far
inside its token budget while one read tool's output makes its memory unbounded.

Every failure HALTS: the run goes FAILED with the integrity code in
`errorMessage`, a `WORKFLOW_CONTEXT_INTEGRITY_HALTED` audit row is written, and
`agentic.workflow.context_integrity.halt{code}` counts it. Nothing repairs,
coerces or truncates.

### The bug this replaces

```ts
    try {
        return run.contextJson ? (JSON.parse(run.contextJson) as WorkflowContext) : { input: {}, outputs: {} };
    } catch {
        return { input: {}, outputs: {} };
    }
```

That catch was the whole vulnerability in one line. A context the engine could
not read did not stop the run — it silently RESET the agent's memory and carried
on, so a corrupted or poisoned context produced a run that looked healthy and
reasoned from state nobody wrote. There is no catch in the replacement;
`openSealedContext` has no path that returns a context it could not verify, and
`executeFrom` has no path that continues without one.

### Where the checks sit

```
startWorkflowRun ── create row ─┐
                                ├─ ONE transaction: seal at seq 0, prev null
                                └─ contextJson + contextHash written together

executeFrom
  ├─ open + verify once (covers the zero-step / completion path)
  └─ per step:
       caps → getRunRow (abort/pause) → RE-OPEN AND VERIFY FROM THAT ROW
            → run the step → commitContext (validate, size-check, seal, write)
```

The per-step re-open is what makes "a tampered context is caught at the NEXT
step" true rather than asserted. The between-steps window is real — a checkpoint
can pause a run for days and `resumeWorkflowRun` re-enters `executeFrom` — and a
verifier that only ever checked its own in-memory copy would see nothing that
happened in it. The row is already being fetched for the abort check, so it
costs no extra query.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/context-integrity.ts` | NEW. Envelope schema, `computeContextLink`, `sealContext`, `openSealedContext`, `ContextIntegrityError`, `MAX_CONTEXT_BYTES`, `describeContextHalt`. |
| `src/app-layer/usecases/workflow-runs.ts` | Seals at run creation; opens-and-verifies before the loop and again at every step; `commitContext` replaces three raw `JSON.stringify(context)` writes; new `haltRun`; `loadContext` + `currentCost` deleted. |
| `prisma/schema/agentic.prisma` | `WorkflowRun.contextHash String?` — the chain head. |
| `prisma/migrations/20260905153000_workflow_context_integrity/migration.sql` | `ADD COLUMN "contextHash" TEXT`. No backfill, deliberately. |
| `src/lib/observability/metrics.ts` | `recordWorkflowContextIntegrityHalt` (counter, labelled by code) + `recordWorkflowContextBytes` (histogram). |
| `tests/unit/workflow-context-integrity.test.ts` | The three behaviours + a positive control + the digest-only assertions. |
| `tests/integration/workflow-context-integrity.test.ts` | The two claims a double cannot make: the chain survives the encrypt/decrypt round trip, and the two columns are different kinds of thing. |

## Decisions

- **The head is a COLUMN, not a field inside the envelope.** A head stored
  inside the blob it protects can be recomputed by whoever rewrote the blob, so
  it would certify nothing. `AuditLog.entryHash` is a column for exactly the
  same reason. What this construction detects is a write to `contextJson` that
  did not come through `sealContext`; what it does NOT detect is an attacker who
  rewrites the context and the head together — the same residual the audit trail
  answers with its immutability trigger. That is stated in the module header
  rather than implied, because a chain whose limits are unwritten gets trusted
  past them.

- **`contextHash` is NOT in the encryption manifest.** It is a digest, it
  carries no content, and it is compared for equality on every step. An
  encrypted column would compare one ciphertext against another and the chain
  would never verify. A unit assertion pins this, because "encrypt the new
  column too" is the plausible-looking change that would silently disable the
  whole mechanism.

- **No backfill, and unsealed FAILS CLOSED.** Existing rows were never sealed,
  so any value written to their `contextHash` would be a seal nobody computed.
  NULL therefore means UNSEALED, and an unsealed run halts with
  `CONTEXT_UNSEALED` at its next step rather than adopting the blob. The cost is
  real and is accepted: a run in flight across this deploy dies and must be
  restarted. The alternative is trust-on-first-use, which is a bypass available
  to anyone who can clear the column — and clearing a column is strictly easier
  than forging a hash.

- **The cap halts rather than truncating, and that is the single most important
  line in the change.** A truncated context is small, well-formed and
  verifiable, and has quietly lost whatever was at the end of it — downstream it
  is indistinguishable from a context that was always that small. Halting leaves
  the previous verified context in place and reports the size; the oversize IS
  the finding. (#1944's principle.)

- **256 KiB, and why a byte count rather than a token count.** The engine
  already estimates tokens for its spend budget, and that estimate is a
  4-chars-per-token heuristic — fine for a budget, wrong for a boundary that
  decides whether a run dies. Bytes are what the column stores, what the
  encryption layer processes and what the hash covers, so the cap is measured in
  the unit the failure actually occurs in.

- **An integrity failure is checked BEFORE the generic step-failure handler.**
  It is not a step failure: the step ran, the context it produced is the
  problem. Falling through to `failRun` would file a tool error where the finding
  is a poisoned or oversized memory, and would also record a FAILED
  `WorkflowStep` for a step that did not fail. A distinct audit action means
  "this run stopped because its memory could not be trusted" is a query rather
  than a string search through step errors.

- **Nothing that leaves this subsystem carries context content.**
  `ContextIntegrityError.detail` is a closed shape of numbers, codes and SHA-256
  digests, and `describeContextHalt` can only render those fields — so a future
  caller cannot log raw context by accident. `issueFields` is filtered to the
  five envelope key names, so a tenant-controlled key inside `input` cannot ride
  out in a field name. Same digest-only posture as `computeInputDigest` in
  `src/app-layer/ai/decision-log`.

- **`sealContext` is imported from the audit trail's leaf module
  (`@/lib/audit/canonical-hash`), not the `@/lib/audit` barrel.** The barrel
  pulls `audit-writer`, and therefore Prisma, into every consumer.

- **Two reads of the run row became one.** `loadContext` and `currentCost` each
  did their own `getRunRow` before the loop. Incidental, but the replacement had
  to touch both anyway.

## Known gap

`startWorkflowRun` seals inside the create transaction, so an oversized starting
`input` rolls the run back and surfaces as a 400 naming the cap. Every other
halt is a FAILED run. Those are different shapes for the same class of failure,
and the split is deliberate — there is no run to fail before the row exists —
but a caller reading only run statuses will not see the start-time refusals. The
metric counts both.
