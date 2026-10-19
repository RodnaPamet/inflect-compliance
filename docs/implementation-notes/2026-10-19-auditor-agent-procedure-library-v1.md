# 2026-10-19 — The auditor agent and audit procedure library v1 (step 3c)

**Commit:** `feat(agentic): the auditor agent runs audit procedure library v1 on the control-test runner (3c)`

Step 3c of the agentic IAM roadmap (#3676, part of #3658 · UC4). The five
library-v1 procedures of `docs/agentic-audit-procedures.md` run as handlers
on the existing control-test runner, as the registered auditor agent, and each
run writes one workpaper through 3b's writer.

## Design

```
ControlTestPlan(INTEGRATION, automationConfig = { procedure, auditorAgentId,
                parameters, sampleSize?, periodLabel? })      ← set only by the auditor's owner
  → control-test-runner (tx budget 120 s for automated runs)
  → agenticControlTestHandler: `check` → the four checks; `procedure` → audit procedures
  → auditProcedureHandler (services/audit-procedures/index.ts)
       auditor standing: registered · isAuditor · ACTIVE · no kill switch ·
                         grants ⊆ read tools ∪ {propose_finding} · independent
       period: pinned, or the latest ended month/quarter
       preconditions: PERIOD_OPEN · PARAMETER_UNSET · PERIOD_NOT_SETTLED
       module.read()  → population from raw rows (cap 5000, read one past)
       POPULATION_TRUNCATED · EMPTY_POPULATION · module preconditions
       freeze → digest → binding sample (reuse) or keyed draw (epoch, fingerprint)
       module.evaluate(sample) → attribute results → judgeUnit → decideConclusion
       each exception → propose_finding through the funnel, as the auditor
                         (or the live proposal an earlier run raised)
  → ControlTestRun + Evidence (facts, frozen id list); no runner Finding
  → afterEvidence → recordAuditWorkpaperInTx (same transaction, cites the evidence)
```

The pure rules — config, periods, the conclusion order, the sample, the remit,
the proposal text — live in `src/lib/agentic/audit-procedure-library.ts`. Each
procedure is a module that only reads and judges; the orchestrator alone
freezes, samples, concludes, proposes and records, so no procedure can be the
one that concludes differently.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/audit-procedure-library.ts` | library v1 definitions and status, plan config, periods, sample, conclusion, remit, proposal text |
| `src/lib/agentic/audit-workpaper.ts` | an exception names its proposal (`proposalId`), which must be in `proposalIds` |
| `src/app-layer/services/audit-procedures/index.ts` | the handler: standing, preconditions, freeze, sample, propose, record |
| `src/app-layer/services/audit-procedures/{leaver-timeliness,recertification-completeness,time-bounded-access-expiry,privileged-access,agent-authority-conformance}.ts` | one module per procedure |
| `src/app-layer/services/audit-procedures/shared.ts` | the module contract, sync freshness, caps |
| `src/app-layer/services/agent-control-tests.ts` | the INTEGRATION handler dispatches `procedure` configs |
| `src/app-layer/jobs/control-test-runner.ts` | `runId` in the input; `findingsRaisedAs`, `afterEvidence`; automated-run tx budget |
| `src/app-layer/usecases/audit-workpaper.ts` | `recordAuditWorkpaperInTx`, the writer on the caller's transaction |
| `src/app-layer/usecases/auditor-remit.ts` | the remit, refused at grant, mark and activation |
| `src/app-layer/usecases/agent-tool-exposure.ts`, `agent-registry.ts` | call the remit refusals |
| `src/app-layer/usecases/test-scheduling.ts` | only the auditor's owner sets, changes or removes a procedure plan |
| `src/lib/agentic/flue/skills/iam-audit-procedures/` | the skill and its evaluation set; no record |

## Decisions

- **One slot, two engine families.** The runner holds one handler per
  automation type and throws on a second registration. Rather than widen the
  registry, the INTEGRATION handler dispatches on the config's key: `check` is
  an agentic check, `procedure` is an audit procedure, anything else is
  declined by both. There is still one runner and one registration.
- **The workpaper is written inside the runner's transaction.** The runner
  creates the `ControlTestRun` uncommitted and hands the handler its
  transaction; a second transaction cannot see the run and the writer would
  refuse `RUN_NOT_FOUND`. So 3b's writer gains an in-transaction entry, and the
  runner calls a handler's `afterEvidence` once the evidence exists, so the
  workpaper cites the evidence that carries its frozen id list. Automated runs
  get a 120 s transaction budget, because the handler (reads, chain
  verification, proposals) runs inside it.
- **The runner writes no Finding for a procedure.** The catalogue left this to
  3c. A runner Finding beside the proposals would be a direct path to a Finding
  the auditor's grants never allowed, and every exception would reach a person
  twice. `findingsRaisedAs: 'PROPOSALS'` suppresses it; a FAIL still attests.
- **The auditor speaks for its owner.** Proposals go through `resolveMcpInvocation`
  and `runProposeTool` with `agentId` the auditor and the principal its
  accountable owner, resolved from the owner's own membership (custom role
  included), `actorType: 'JOB'`. The plan's author is not the principal: anyone
  who can manage test plans could otherwise lend the auditor their authority.
- **An exception is raised once per procedure and period.** Each exception
  names its proposal on the workpaper. A later run reuses a live proposal
  (pending, or decided by a person) for the same unit and code instead of
  raising it again, links a finding a person created from it, and re-raises
  only one that EXPIRED undecided. Proposing stops at the first refusal; the
  rest are counted and the basis says `EXCEPTIONS_NOT_ALL_PROPOSED`.
- **The second line sets the plan.** `scheduleTestPlan` refuses a write that
  puts, changes or removes a procedure config unless the caller is a person who
  owns the named auditor (second line, by the independence rule). A malformed
  procedure config is a 400 rather than a plan that runs `CONFIG_INVALID`.
- **The remit is held four times.** Granting an auditor a tool outside read
  tools and `propose_finding`, marking an agent that holds one, and activating
  an auditor that holds one are refused `AUDITOR_REMIT_EXCEEDED`; and the
  handler refuses to run such an auditor. No trigger: the remit is the build's
  tool catalogue, which SQL cannot read.
- **Two sub-populations, one epoch on the workpaper.** Procedure 4 stores the
  base epoch; its sub-populations are drawn with `/directory` and
  `/membership` appended, and their unit ids carry the same prefixes, so one
  frozen list, one digest and one binding sample hold both.
- **Reproducible from the epoch.** The seed is `deriveSubkey` of
  `inflect-audit-procedure-sample-v1:<tenantId>`, never stored; the workpaper
  records its fingerprint. The integration test re-derives a stored sample
  from the epoch, the seed and the frozen ids.
- **Procedure 5 does not audit the auditor.** Windows of agents marked
  `isAuditor` are excluded and counted, applying rule 8 and 3b's definition of
  an audited agent. Without it, an auditor with no card would raise
  `NO_CARD_IN_FORCE` against its own proposals every month.
- **A1 and A4 are asked at each recorded call.** "For the whole hour" is read
  at each per-call record in the hour, and over the whole hour only when there
  is none, so a tool granted at 10:20 and called at 10:25 is not an exception.
  Both this and the exclusion above are interpretations of catalogue version
  1, recorded on the pull request for internal audit, not changes to it.
- **Procedure 2 cannot be empty while an auditor exists.** Its memberships
  unit is present whenever a membership is ACTIVE, and the auditor's owner's
  is. The module is tested to return no unit without one.
- **The skill is unmounted.** `iam-audit-procedures` ships its evaluation set
  and no record: the record needs a model call this change could not make, and
  a record is never written by hand. No workflow declares it, because CI
  refuses a registered workflow that declares a skill the mount gate refuses.
