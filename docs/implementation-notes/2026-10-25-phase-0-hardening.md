# 2026-10-25 — Phase 0 hardening (Claude agents 0H)

**Commit:** `<sha> fix(agentic): Phase 0 hardening (Claude agents 0H)`

Step 0H of the roadmap in `docs/claude-agent-sdk-design.md` (#4141). It
re-reads Steps 0a–0d together, mutation-proves the conformance suite on main,
and records what Phase 0 has done in production.

## Design

Three passes, each reported below:

1. **An adversarial read of the four merged diffs:** 0a #4176, 0b #4220, 0c
   #4181 and 0d #4111. It looked for what each step's own checklist could not
   see.
2. **A mutation sweep** over every conformance scenario, run on main after
   #4201 (the per-model-call kill and cap check) landed.
3. **Read-only production evidence**, per CLAUDE.md's "Production VM" section.

## The adversarial read

| Step | Looked for | Found | Outcome |
| --- | --- | --- | --- |
| 0a | a `'flue'` comparison the sweep missed | Two in `workflow-runs.ts`. Both wrote `WorkflowRun.driver` as `driver === 'flue' ? 'FLUE' : 'STATIC'`, so a third engine would be recorded as STATIC with nothing failing | Fixed by #4285 (#4270), found independently by another session and merged first: both writes read `recordedModeOf`, a `Record<AgentDriver, AgentDriverMode>`, so `tsc` refuses an engine with no stored mode. This pull request keeps only an integration test, `workflow-run-skill-pin` › "records the engine the run executes on": it asserts the start path writes the mapped mode, and recording Flue as STATIC turns it red |
| 0a | a guard source string that changed | None. `flue-tool-args`, `flue-tool-result`, `flue-tool-result-egress` and `flue-delegate-answer` are byte-identical before and after | — |
| 0b | a scenario that passes for a reason other than its control | None vacuous. The sweep did show that since #4201 each cap is charged at two or three sites, so a mutation of one site is green because the next site still holds the cap | The 0b table was corrected to remove every site. See "Mutation sweep" |
| 0c | a page state the API can produce but the page does not render | Eight, from an independent read, each verified here | Six fixed here, one filed as #4224, one left as is. See below |
| 0d | anything the step's tests could not see | Four defects in `/api/mcp`, plus scanner blind spots older than the step | The defects (#4205) are fixed in #4210. The scanner gaps (#4206) are fixed in #4212: keys are scanned, and content past depth 64 is refused |

### The Agent engines section (0c)

Each fix has a rendered test in `tests/rendered/admin-agent-engines.test.tsx`
that is red against the 0c component and green against this one.

1. **The section said Flue was running when no Flue run could start.**
   - **What happened:** the headline and the badge were green with Flue
     effective and no active registered agent or bound key. Every start in that
     state is refused (`flue_requires_registered_agent`), not moved to the
     built-in engine.
   - **Fix:** `headlineFor` and `headlineToneFor` take the owner's checklist.
     When it says the workspace is not ready, the headline says no Flue run can
     start yet, in a warning tone.
   - **For other viewers:** a viewer without the checklist reads a headline
     that names the condition, and the bound-key note is now shown to every
     viewer.
2. **An owner could not narrow back to the built-in engine while the
   deployment switch was off.**
   - **Why it mattered:** a stored Flue choice is not inert. It takes effect
     the moment the operator turns the switch on.
   - **Fix:** `choiceEnabled` keeps the built-in engine reachable for an owner
     under every control, and a sentence says the stored choice is waiting on
     the switch.
3. **A checklist that was loading or failed was shown as the owner's
   checklist.** It appeared as the gate's three terms under "What a Flue run
   needs". Until the checklist arrives, the three terms now sit under the
   gate's own heading, with a notice if the checklist failed.
4. **A save that never reached the server left the dialog open with no
   message.** The fetch's own failure now sets the message.
5. **A viewer with no control read "The choice below is disabled".** The notice
   now appears only over the control it describes.
6. **A failed refresh replaced a section that had loaded, and a failed refetch
   after a successful save held the dialog open.** The error state now needs
   no data to show. A refresh failure is a notice beside the data, and the
   dialog closes once the change is made.
7. **Not fixed here, filed as #4224.** A stored engine this build does not know
   fails the typed read before the coercer runs. The GET and the PUT both
   return 500, so `UNRECOGNISED_SETTING` is unreachable and the owner cannot
   replace the value. It is reachable only on a rollback past Step 2b, so it is
   filed against that step.
8. **Left as is.** A server refusal is shown in English in the Bulgarian
   locale, because `apiErrorMessage` prefers the server's text. That is an
   app-wide pattern, not this section's.

## Mutation sweep

Run on the 0b branch after rebasing onto main with #4201. Each mutation was
applied to one source file, the suite was run, and the file was restored. Each
mutation turned exactly its own scenario red, and nothing else.

| Mutation (in `src/`) | Scenario that went red |
| --- | --- |
| `beforeModelCall` not awaited | `kill-switch-between-model-calls` |
| TOOL_CALLS charge removed | `cap-tool-calls` |
| TOKENS charged nowhere (both sites) | `cap-tokens` |
| RUNTIME_MS charged nowhere (all three sites) | `cap-wall-clock` |
| argument guard removed | `secret-argument-refused-before-the-funnel` |
| result guard removed | `flagged-result-withheld-from-the-model` |
| residency read forced to `EXTERNAL` | `local-only-never-external` |
| decision-row write removed | `decision-row-per-model-call` |
| runtime tools not reported | `tool-surface-bounded-and-reported` |
| `MODEL_CALL` step under-reports its calls | `ledger-accounts-for-every-call` |
| successful `TOOL_CALL` step not written | `ledger-accounts-for-every-call` |
| registration gate skipped | admission, `no_binding` and `suspended` |

With the gate skipped, `unresolvable` is still refused, by
`WorkflowRun_agentId_tenantId_fkey`.

## Production evidence

**Not collected.** Every attempt on 2026-10-25 stopped at access:

- **This session:** the environment's `CLOUDSDK_AUTH_ACCESS_TOKEN` was rejected
  as invalid credentials, both early in the day and at about 10:40 UTC.
- **A fresh session** in the same environment, started at 14:04 UTC to pick up
  a refreshed value, got the same rejection at its first read-only command. It
  ran nothing on the VM.

So this note claims no production run and no log count. The design document's
"Operational evidence" row for Phase 0 says the same. The two hardening items
that need production stay open on the pull request until a read-only pass with
working credentials fills them:

- **A Flue run after 0a:** its `WorkflowRun` id, and the `MODEL_CALL` and
  `TOOL_CALL` counts against a run of the same workflow before 0a.
- **`/api/mcp` limits since #4111:** the `rate-limit.blocked` counts by scope,
  and whether `api-mutation` still appears for `/api/mcp`.

The queries are in the step's prompt. Nothing here is filled from a test.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/workflow-runs.ts` | both `WorkflowRun.driver` writes read it |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/agent-engine-display.ts` | readiness-aware headline and tone; `choiceEnabled` |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/AgentEnginesSection.tsx` | the six rendering fixes |
| `messages/en.json`, `messages/bg.json` | two sentences reworded, four added |

## Decisions

- **The two-site caps are correct, so the table changed rather than the code.**
  Charging the caps before every model call was #4201's point. A one-site
  mutation staying green proves the second site works, so it is not a vacuous
  scenario. The rows now name a mutation that removes the cap.
- **Narrowing is always offered.** 0c disabled the whole choice under a switched-off
  deployment, on the rule that a control whose success changes nothing is a
  trap. That holds for the widen. It does not hold for the narrow, which
  decides what happens the moment the switch is turned on.
- **#4224 is filed, not fixed.** The fix is a text read shared with the run
  path's resolver, and the step that adds the next stored value is where it can
  be tested against a real one.
