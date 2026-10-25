# 2026-10-25 — The "Agent engines" section on AI features

**Commit:** `<sha>` feat(admin): agent engines section on AI features

Step 0c of the roadmap in `docs/claude-agent-sdk-design.md` (#4139). The section
gives the tenant's engine choice a page that every admin can read and only an
owner can change. It names the reason the effective engine is what it is, in
plain words.

## Two facts the design had wrong, and the owner's two decisions

The prompt was written against two assumptions, and the code disproved both. Per
global rule 1, the code wins. Both deviations went to the owner before any code
was written, and both decisions are recorded on #4139.

1. **"A user who does not hold `admin.tenant_lifecycle` sees the state
   read-only"** could not hold. The whole AI features page sat behind a
   `RequirePermission` for that key, and so did `GET /admin/agent-driver`. An
   ADMIN could neither reach the page nor read the state, and the prompt ruled
   out a new route, permission or usecase. **Decision:** the GET takes
   `admin.view`, the PUT keeps `admin.tenant_lifecycle`, and the page's gate
   moves from the page to its sections.
2. **"Today it can only be set through `PUT /admin/agent-driver`"** was
   false. `FlueEngineCard` on Admin → Integrations already toggled the column
   for owners, with the six-term wiring checklist from `GET /admin/flue-wiring`.
   It had no confirmation, no reason in words, and no disabled state when the
   deployment's switch was off. Building the section beside it would have left
   two controls on one column. **Decision:** consolidate on AI features. The
   checklist moves into the section, for owners. The card is deleted, and
   Integrations keeps a one-line link where it stood.

## Design

```
/admin/ai-features                   page: admin.view (the layout)
├── header
├── RequirePermission(admin.tenant_lifecycle)
│     ├── AiFeaturesClient            the four AI switches (unchanged)
│     └── fallback: "Only a workspace owner can turn AI features on or off…"
└── AgentEnginesSection               every admin
      GET /admin/agent-driver         admin.view       (was tenant_lifecycle)
      GET /admin/flue-wiring          tenant_lifecycle (requested only by an owner)
      PUT /admin/agent-driver         tenant_lifecycle (unchanged)
```

`agent-engine-display.ts` is pure and holds the section's three decisions:

- `headlineFor`: the sentence for the effective engine. `REASON_MESSAGE` is
  `satisfies Record<StaticDriverReason, string>`, so a new reason without a
  sentence fails `tsc`.
- `engineControlFor`: `read-only` for anyone without the change key,
  `deployment-off` for an owner whose deployment switch is off, otherwise
  `editable`.
- `gateTermsFor`: the three terms the driver GET can answer by itself. An owner
  gets the six-term checklist instead.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/page.tsx` | Page shell. The AI switches get a section-level gate and the engines section is added |
| `…/ai-features/AgentEnginesSection.tsx` | The section: headline, terms, choice, ConfirmDialog |
| `…/ai-features/agent-engine-display.ts` | Reason sentence, control and terms, as pure functions |
| `…/ai-features/AiFeaturesClient.tsx` | Header moved to the page, otherwise unchanged |
| `…/admin/integrations/FlueEngineCard.tsx` | Deleted. Integrations links to the section instead |
| `src/app/api/t/[tenantSlug]/admin/agent-driver/route.ts` | GET is `requirePermission('admin.view', …)` |
| `src/lib/security/route-permissions.ts` | A method-scoped GET rule above the agent-driver catch-all |
| `messages/{en,bg}.json` | `admin.agentEngines`, which replaces `admin.flue` |
| `.env.e2e.example` | `AGENT_DRIVER_FLUE=1`, so the E2E spec can reach an editable control |

## Decisions

- **The checklist route is not requested by a non-owner.** `useTenantSWR`
  takes a `null` path for anyone who cannot change the engine. If the section
  asked anyway, every admin who opened the page would write an `AUTHZ_DENIED`
  row, and a refusal that fires on every page view buries the real ones.
- **`flue-wiring` stays `admin.tenant_lifecycle`.** Its response adds counts
  over the agent register, and it is the owner's checklist for wiring a run.
  Its old justification was that it was a superset of what the tenant-lifecycle
  GET guarded. That stopped being true when the GET opened, and its notes now
  give the real reason.
- **The AI switches stay owner-only to read.** Their route note gives the
  reason: the GET discloses the deploy-level flags. So `admin.view` now reads
  the agent-engine switch (`envEnabled`) but not the AI-feature flags. That
  difference is deliberate. The owner opened the engine read and nothing else,
  and the PR's risk assessment names it.
- **Disabled, not hidden, when the deployment is off.** The AI switches
  render no control when the platform forbids a feature. Here the prompt asked
  for a disabled choice, so the owner can see what they would be choosing
  between. The notice above it says the operator turns the switch on.
- **`UNRECOGNISED_SETTING` has a sentence it cannot be shown today.**
  `getAgentDriverSetting` coerces the stored value before resolving, and a
  Prisma client refuses an enum value it was not generated with, so this GET
  never returns that reason. It is still in the union, so it has a sentence.
  Otherwise the day it becomes reachable it would render a code.
- **The confirmation says what changes for running and future runs**, and the
  wording follows the code. A run that is executing keeps its engine. A paused
  run re-resolves its driver when resumed (`resumeWorkflowRun`), so it follows
  the new setting, and so does every new run.
- **Tones are `warning` for the widen and `info` for the narrow, never
  `danger`.** This repo reserves `danger` for the irreversible, and both
  directions here are one more choice away.
- **E2E turns the deployment switch on for the whole E2E environment.** It
  changes nothing for other tenants, which default to the built-in engine, and
  a Flue run also needs a registered agent and a bound key.
