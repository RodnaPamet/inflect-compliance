# 2026-10-29 — Agent runs page: a start form from `requiredInput`

**Commit:** see the `claude/fix-agent-runs-page` branch (#4472)

## Design

`/agents/runs` lists every registered workflow, and every Start button posted
`{ workflowKey }` alone. Seven definitions declare `requiredInput`, and
`assertRequiredInputPresent` refuses a run without it, so seven of the ten buttons
could never start one. The owner decided (2026-10-29) that each workflow that
needs input gets a small form for it on the page, rather than being hidden.

One generic form, driven by the definition's own declaration:

```
WorkflowDefinition.requiredInput ──► startPlanFor(def) ──► ONE_CLICK | FORM(fields) | NOT_HERE(reason)
                                       │
                                       ├─ START_FIELDS[inputName]   how to collect a value of that name
                                       └─ NOT_STARTED_HERE[key]     workflows whose input this page cannot collect
```

- `src/lib/agentic/workflow-start-plan.ts` is pure data and one pure function, so
  the client component can call it. `START_FIELDS` is keyed on the INPUT NAME,
  not the workflow, so `frameworkKey` is the same framework picker in both
  workflows that take it.
- `WorkflowStartModal` renders one `FormField` per declared input: a `Combobox`
  over `GET /frameworks` for a framework, an `Input` for text. It refuses only a
  blank value (what admission refuses) and a format the run's first step validates
  (`periodLabel`). The server's refusal is shown through `apiErrorMessage`.
- A workflow with no required input starts in one click, as before.

Alongside, the list itself:

- After Start, Resume or Abort the client calls `router.refresh()` and renders
  the server page's rows, rather than replacing them with the raw
  `GET /agent-runs` response, a different shape (`_count.proposals`, no
  `pendingProposals`).
- The page reads `RUN_LIST_CAP + 1` runs and reports `truncated`.
- Rows carry `workflowName`; status is a label from `agents.runs.status`.
- Resume is offered for `PAUSED` as well as `AWAITING_APPROVAL`, the two
  statuses `resumeWorkflowRun` accepts.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/workflow-start-plan.ts` | The planner: field kinds by input name, the not-here list, the form's own check |
| `src/app/t/[tenantSlug]/(app)/agents/runs/WorkflowStartModal.tsx` | The one start form |
| `src/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient.tsx` | Start buttons by plan, router refresh, labels, Resume for PAUSED, truncation notice |
| `src/app/t/[tenantSlug]/(app)/agents/runs/page.tsx` | Reads one past the cap, projects `workflowName`, passes `requiredInput` |
| `messages/en.json`, `messages/bg.json` | `agents.runs.{status,notHere,startForm,truncated,pausedHint}`, corrected `description` |

## Decisions

- **Four workflows are NOT started here, and stay visible, disabled, with the
  reason.** This is the page's convention for a control the operator cannot use.
  - `ad-hoc-question`: the Ask page binds the designated agent and bounds the question.
  - `agent-recertification-pack`: its inputs are set by an access review's pack preparation.
  - `sap-transaction-review`: its `facts` are host-supplied JSON.
  - `discovered-agent-review`: it takes an internal id, and no list exists to pick one from.

  These are reported to the owner rather than guessed at.
- **Unknown input fails closed.** A definition declaring a key `START_FIELDS`
  does not know is `NOT_HERE: UNCLASSIFIED_INPUT`, never a guessed text box. The
  unit test walks the registry so a new key fails CI until it is classified.
- **`periodLabel`'s pattern is a copy, held equal by a test.** The source,
  `PERIOD_LABEL`, lives in a module that imports `node:crypto`, which a client
  component may not reach.
- **The framework picker offers the whole catalogue (`/frameworks`), not
  `?inUse=true`.** Framework onboarding is for a framework with no mapped
  controls yet, which the in-use filter would exclude.
- **Refresh through the router, not a client re-fetch.** One projection of a
  row, in `page.tsx`. The truncation fact is computed once there too, with no
  change to the `GET /agent-runs` contract that the agent detail Runs tab also
  reads.
- **A page-specific truncation notice, not `TruncationBanner`.** The banner tells
  the reader to refine their filters, and this page has none.
- **The form's submit is secondary, with a ghost Cancel.** The product-wide
  primary count is a ceiling (`primary-secondary-ratio`).
