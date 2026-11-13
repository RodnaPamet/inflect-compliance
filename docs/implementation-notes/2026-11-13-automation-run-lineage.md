# 2026-11-13 — an automation-started run names the execution that took the action

## Design

#3537 put `parentExecutionId` on `WorkflowRun` so a reader can walk
`execution -> ruleId` from a run: the process canvas's agent view
(`listCanvasAgentRuns`) puts a run on its rule's node that way, and the run
page names the rule through `readWorkflowRunProvenance`.

`INVOKE_AGENT` (and `INVOKE_SUBFLOW`) read the parent from
`event.data.__parentExecutionId`. Only the chain and sub-flow dispatchers set
that marker, and each set it to its OWN parent rather than to the execution it
had just claimed for the rule taking the action. So the lineage was one hop
short everywhere:

| firing | run's `parentExecutionId` before | after |
| --- | --- | --- |
| direct event | `''` — matches no execution, invisible on the canvas | the rule's execution |
| chain step | the UPSTREAM rule's execution — wrong node, or none | the chain step's execution |
| sub-flow entry | the invoking rule's PARENT | the entry rule's execution |

`ActionEvent` now carries `executionId`, the row the calling dispatcher claimed,
and all three dispatchers set it. `invokeAgent` and `invokeSubflow` read it.
`data.__parentExecutionId` is left as it was, because a WEBHOOK posts `data`
verbatim and a typed field changes no customer's payload.

## Decisions

- **`''` stays `''` in the payload when no execution is given**, not `null`.
  NULL means "nothing caused this run", and the ad-hoc-question result's
  requester gate (`parentExecutionId: null`) relies on that: reading an
  automation-started run as NULL would let a rule's owner read it as the asker.
  Every dispatcher now supplies an id, so the fallback is only for a caller
  that does not.
- **Stored `''` rows are read as "a rule caused it; the execution is unknown".**
  The run page tested truthiness, so such a run showed "Started by <owner>",
  the exact misattribution #3537 removed. It now tests `!== null` and shows
  the unnamed-rule sentence. The canvas cannot place these runs and does not
  try. The ad-hoc gate already excluded them.
- **No backfill.** The only way to recover a `''` run's execution is the
  `(agentId, workflowKey, time)` join that #3537's reader refuses to make
  because two rules can invoke the same agent on the same workflow.
- **A directly fired `INVOKE_SUBFLOW` now gets an idempotency key.**
  `subflowIdempotencyKey('')` is null, so a retry could run a direct firing's
  sub-flow twice. With the execution id it has the same claim (#5103) as a
  chained one. For a chain step the key moves from the upstream id to the step's
  own id, which is unique per step and stable across that step's retries.
