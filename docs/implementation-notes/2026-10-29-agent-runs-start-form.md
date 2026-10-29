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
WorkflowDefinition.requiredInput ──► startPlanFor(def, abilities) ──► ONE_CLICK | FORM(fields)
                                       │                                | ON_ANOTHER_PAGE(path) | NOT_HERE(reason)
                                       ├─ START_FIELDS[inputName]      how to collect a value of that name
                                       ├─ FIELD_NEEDS[kind]            the ability a picker's list needs
                                       ├─ STARTED_ON_ANOTHER_PAGE[key] the page that starts it, and that page's gate
                                       └─ NOT_STARTED_HERE[key]        workflows whose input this page cannot collect
```

`abilities` (`StartAbilities`) are resolved by `page.tsx` from the gates the
relevant routes apply, never inferred in the client:

- `discoveredAgents` combines two checks. One is `checkAdminAccess`, called
  with the session claim the middleware reads. The other is
  `mayReadAgentInventory`, the keys the list route requires.
- `askPage` is `controls.view`, the Ask page's own gate.

- `src/lib/agentic/workflow-start-plan.ts` is pure data and one pure function, so
  the client component can call it. `START_FIELDS` is keyed on the INPUT NAME,
  not the workflow, so `frameworkKey` is the same framework picker in both
  workflows that take it.
- `WorkflowStartModal` renders one `FormField` per declared input: a `Combobox`
  over `GET /frameworks` for a framework, a `Combobox` over
  `GET …/admin/agents/discovered` for a discovered agent, an `Input` for text. It refuses only a
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
| `src/lib/agentic/workflow-start-plan.ts` | The planner: field kinds by input name, abilities, the other-page and not-here lists, the form's own check |
| `src/app/api/t/[tenantSlug]/admin/agents/discovered/route.ts` | The discovered-agent list, `requirePermission` on the inventory read |
| `src/app-layer/usecases/discovered-agent-list.ts` | Tenant-scoped, newest seen first, one past a 200 cap, `truncated` |
| `src/lib/security/route-permissions.ts`, `src/lib/auth/guard.ts` | The route's rule; `discovered` as a static segment beside `[agentId]` |
| `src/app/t/[tenantSlug]/(app)/agents/runs/WorkflowStartModal.tsx` | The one start form |
| `src/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient.tsx` | Start buttons by plan, router refresh, labels, Resume for PAUSED, truncation notice |
| `src/app/t/[tenantSlug]/(app)/agents/runs/page.tsx` | Reads one past the cap, projects `workflowName`, passes `requiredInput` |
| `messages/en.json`, `messages/bg.json` | `agents.runs.{status,notHere,startForm,truncated,pausedHint}`, corrected `description` |

## Decisions

- **The owner settled the four workflows the first version could not start**
  (2026-10-29):
  - `ad-hoc-question` LINKS to the Ask page. The Ask page binds the designated
    agent and bounds the question, which a run started here would not. The
    link is offered on the Ask page's own gate rather than on write access,
    because following it starts nothing here.
  - `discovered-agent-review` gets a picker over a new list API, offered only
    to a caller who can call that API.
  - `agent-recertification-pack` (its inputs are set by an access review's
    pack preparation) and `sap-transaction-review` (its `facts` are
    host-supplied JSON) stay disabled, each with its reason. Disabled is the
    page's convention for a control the operator cannot use.
- **The list API takes the inventory read and no new key.** It requires
  `admin.agent_registry_view` OR `admin.agent_registry`. That is what the
  harness-scans list takes, and what `get_discovered_agent` (the run's first
  read) asserts, so the picker never offers a row the run could not read.
  - It is not added to `AUDITOR_ADMIN_READ_PATHS`: the picker serves a person
    starting a run, which an AUDITOR may not.
  - `discovered` is listed in `AGENT_ADMIN_API_STATIC_SEGMENTS`. Without that,
    the edge reads the segment as an agent id and admits an AUDITOR's GET of it.
- **The page asks the edge with the claim the edge reads.** `ctx.role` is a
  custom role's BASE role; the middleware reads the membership's own role from
  `memberships[]`. Using `ctx.role` would offer the picker to a READER whose
  custom role is built on ADMIN, and the edge would then refuse its load.
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
- **The form has ONE footer action, a secondary "Start run", and no Cancel.**
  Two ratchets meet here:
  - `primary-secondary-ratio` caps the product's primary count, and this page
    has no primary to demote to pay for one.
  - `modal-action-order` requires a footer with two buttons to end on a primary
    or destructive one.

  So dismissal is the dialog's own close button, Escape or the backdrop on
  desktop, and drag or backdrop on the mobile drawer. The alternative is a
  primary submit paid for by demoting another page's primary, which is the
  ledger's usual route but outside this page.
