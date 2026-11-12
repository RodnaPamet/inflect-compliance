# 2026-11-12 — Resuming an agent run is a person's act (#5368)

## Design

`POST /api/t/:slug/agent-runs/:id/resume` takes `admin.view` OR
`admin.agent_registry_view` at the route, and `resumeWorkflowRun` asserted only
the role-tier write. An API key gets `admin.view` from `admin:read`, and any
`:write` scope beside it resolves the key to EDITOR, so such a key passed both
layers. Resuming closes the run's PENDING `HUMAN_CHECKPOINT` as DONE: it is the
approval the checkpoint parked for. So a key, including the agent's own key,
could approve its own parked run.

`resumeWorkflowRun` now refuses, as its FIRST act and before the run is read,
any context that is not a person: `isPersonContext` (API key, bound agent,
`actorType: 'JOB'`) plus `actorType: 'SYSTEM'`. The refusal writes a
hash-chained `AUTHZ_DENIED` row on `WorkflowRun` / the run id, with
`reason: 'agent_run_resume_human_required'` and the caller's kind, through
`appendAuditEntryOrQueue` (fail-closed), then throws `forbidden` with the same
reason. The same rule and shape as `approveAgentProposal`'s
`agent_proposal_human_review_required`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/workflow-runs.ts` | the person check at the top of `resumeWorkflowRun`; exports `RESUME_REQUIRES_PERSON` |
| `src/app/api/t/[tenantSlug]/agent-runs/[id]/resume/route.ts` | docstring names the third layer |
| `tests/integration/resume-workflow-run-person-only.test.ts` | key, agent, JOB and SYSTEM refused with the row and the checkpoint still PENDING; a person resumes |
| `tests/unit/agent-runs-proposals-route-gates.test.ts` | a key that passes the route is refused by the usecase, audited, before the database |

## Decisions

- **In the usecase, not the route.** The route is `resumeWorkflowRun`'s only
  caller. No job, the worker or the A2A reply path resumes a run through it:
  the worker continues a queued run through `executeQueuedWorkflowRun`, a
  SIGTERM'd PAUSED run is restarted by a person through this same route, and a
  peer's reply never resumes anything (`a2a-reply-delivery.ts`). So refusing
  every non-person context breaks no legitimate caller, and a future caller
  inherits the rule rather than a route-only copy of it.
- **Before `assertCanWrite` and before the run is read**, so every machine
  caller gets the named, audited refusal whatever its tier, and nothing about
  the run is disclosed to it.
- **`isPersonContext` is reused, not copied.** It is the one definition of "a
  person"; `SYSTEM` is refused beside it here rather than by changing that
  predicate, whose other callers are out of scope.
- **The agent check reads the CALLER's `agentId`.** The function later builds
  an execution context carrying the RUN's agent; that binding is the run's, and
  the human stays the actor.
