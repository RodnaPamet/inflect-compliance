# 2026-11-13 — Context compaction on the Tool Runner engine (Step 2g, #5531)

**Commit:** `feat(agents): context compaction on the Tool Runner engine (#5531)`

## Design

The design is "Compaction" in `docs/claude-tool-runner-design.md`, with the
owner's three decisions of 2026-11-13: build it as a token-budget measure (the
threshold is the lowest of the tier's constant, 15% of the run's `TOKENS` limit
and the profile version's own value); a nullable
`AgentProfileVersion.compactionThresholdTokens` that may turn it off or lower
it and never raise it; and Inflect's own summary call and rebuild, not the
SDK's `compactBeforeNextTurn()`.

```
runModelLoop, step 9, after a COMPLETE tool round
  compactionSkip(threshold, estimate, steps left ≥ 2, no stop, not twice in a row, not failed this segment)
    └─ due:
       1. readCompactionRecord (ledger from the loop's first seq + proposals, read one past the bound)
          buildRunStateBlock  ── SKILL_PIN_MISMATCH ──► stop the run
       2. stoppedBeforeModelCall (kill switch, breaker, one STEPS)
       3. client.beta.messages.create(compactionParams(runner.params, history))
       4. TOKENS += usage; egress + injection scans; verdict noted first
       5. kill / caps read
       6. compactedMessages(...) → runner.setMessagesParams  (only when the summary may be used)
       7. MODEL_CALL step { purpose: 'compaction', decisionDigest, compactedFromDigest,
                            summaryDigest, messagesSummarised, estimatedTokensBefore }
          output { compactedToDigest, estimatedTokensAfter } | { failed: CODE }
          Art 12 row (summary text only when both scans were clean)
  stoppedBeforeModelCall for the next call (as before)
```

The rebuilt request is `system` and `tools` unchanged, then the opening user
message verbatim, Inflect's run-state block, the summary fenced
`<run_summary source="model">`, and the last turn verbatim with its `thinking`
and `redacted_thinking` blocks dropped. `compactedToDigest` equals the next
call's `decisionDigest`, so a reviewer can follow which history each call saw.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/tool-runner/params.ts` | `COMPACTION_THRESHOLD_TOKENS`, `COMPACTION_BUDGET_SHARE`, `COMPACTION_SUMMARY_MAX_TOKENS`, `COMPACTION_INSTRUCTION`, `compactionParams()` |
| `src/lib/agentic/tool-runner/compaction.ts` | Pure: the threshold, the trigger, the run-state block, the rebuilt history |
| `src/lib/agentic/tool-runner/execute.ts` | `compactHistory` at loop-body step 9 of the one loop body; the pin-mismatch stop and its settlement |
| `src/lib/agentic/tool-runner/delegate.ts`, `tools.ts` | The child's skills reach its loop; the `SKILL_PIN_MISMATCH` run stop |
| `src/lib/agentic/drivers/run-store.ts` | `readCompactionRecord`: the loop's ledger rows and the run's proposals, bounded, read one past |
| `prisma/migrations/20261113180000_agent_profile_compaction_threshold/` | The column, its CHECK, the lifecycle function replaced with the column frozen |
| `src/app-layer/usecases/agent-profiles.ts`, `agent-profile-runs.ts`, `schemas/agent-profile.schemas.ts`, `lib/agentic/agent-profile.ts`, `workflow-types.ts` | Save and approval refusals, the view and its limits, the resolver, the run spec |
| `BehaviourEditorSheet.tsx`, `BehaviourTab.tsx`, `behaviour-types.ts` | "Summarise long conversations": default, off, or a lower threshold; shown to the approver |
| `run-step-projection.ts`, `AgentRunDetailClient.tsx` | The run page labels a compaction step "Conversation summarised", with the sizes before and after |
| `messages/en.json`, `messages/bg.json` | Strings |

## Decisions

- **The run-state block is read from the ledger, not kept in memory.** The
  design asks that it be deterministic given the ledger and the pins, so it is
  built from the rows the loop wrote since its first seq (and, for a child,
  under its own `subagentName`). Both reads take one row past their bound, and a
  truncated read compacts nothing (`NOT_BUILT`, compaction off for the
  segment): a block from a partial read could drop a pending proposal.
- **Proposals in the parent's block are every proposal of the segment, a
  sub-agent's included; a child's block lists only its own.** The parent is
  accountable for the run; a child's proposals were already reported to it.
- **A refused tool call is listed by name and code, never by message.** A
  funnel error's text can carry tenant content, so a failed call without a
  recorded `refused` code reads `TOOL_ERROR`.
- **The summary call carries no `thread` member at all.** It is a plain
  Messages call, not a runner, and the client's middleware refuses any non-null
  `thread` (`false` included). The design's "`thread: false`" is met by
  holding no thread.
- **A summary call that throws (not a stop) is a failed summary**, recorded as a
  FAILED compaction step with `failed: 'ERROR'` and no Art 12 row (no reply was
  received). An abort this run asked for records nothing, as a parent model call
  aborted in flight records nothing.
- **A skill-pin mismatch at compaction is a run stop** (`RunStop`
  `SKILL_PIN_MISMATCH`, settled after a guard verdict and before the named stop
  reasons) rather than a loop failure, so a child that finds one stops the run
  and not only its delegation.
- **The threshold is not in the content hash.** It is frozen by the version
  trigger and shown to the approver, and an older worker that does not read it
  does not compact, which is today's behaviour: one deploy.
- **"Not twice in a row" is per loop; "off after a failed summary" is per
  segment**, shared by the parent and every child, so a model that will not
  summarise is not asked again in the same segment.
- **Deferral (Step 2f) is not built**, so the design's "not with a deferral
  latched" condition has nothing to read yet; 2f adds it to `compactionSkip`.
