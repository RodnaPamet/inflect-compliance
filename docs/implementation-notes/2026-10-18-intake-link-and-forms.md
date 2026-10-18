# 2026-10-18 — The harness ingest honours the intake's link; the intake and classification forms

**Commit:** _(this PR)_ `feat(agentic): the ingest honours the intake's link; Register and Classify forms (2a intake follow-up)`

Follow-up to the registration intake (#3711), issue #3712. Two gaps: a
`SHADOW_AGENT` finding could stay open for ever if the scanner never learned the
new register id, and both the intake and the classification of a provisional
entry were API-only.

## Design

```
ingest (agent-harness-scans.ts, the single write seam)
  loads known DiscoveredAgents, the claimed register rows, acceptances,
  and NOW the intake rows: RegisteredAgent where intakeDiscoveredAgentId ∈ known ids
  └ planHarnessScan (harness-findings.ts, pure)
      per reported agent:
        reported = claim the register holds            (unchanged)
        intake   = intake row, live and in INTAKE_LINKABLE_STATUSES
        link     = reported ?? intake                   linkBasis REPORT | INTAKE | null
        reported ≠ intake (both set)  → intakeConflicts[]  (the report wins)
        SHADOW_AGENT: null link → assert
                      REPORT link → resolve             (any completeness, unchanged)
                      INTAKE link → resolve on a complete scan, else hold
  └ ingest writes DiscoveredAgent.registeredAgentId as before, and one
    AGENT_INTAKE_LINK_CONFLICT audit row on the intake row per conflict

/agents/reports?tab=harness
  page.tsx: canRegisterShadow = canRunRegistrationIntake(ctx)   (the intake's own rule)
  getHarnessMatrix: each shadow row + findingId + intake {agentId, name, linkable}
  ShadowList "Registration" column → Register (finding, no intake row, permitted)
  RegisterShadowAgentModal → POST /admin/agents/intake

/risks/ai-systems/:id
  canWrite && UNCLASSIFIED → Classify → ClassifyAiSystemModal (next/dynamic)
  → POST /ai-systems/:id/classification
```

## Files

| File | Role |
|---|---|
| `src/lib/agentic/harness-findings.ts` | `IntakeClaim`, `INTAKE_LINKABLE_STATUSES`, `isIntakeClaimLinkable`, `intakeClaimsByDiscoveredId`; `planHarnessScan` reads `prior.intakeClaims`, returns `linkBasis` per agent and `intakeConflicts`. |
| `src/app-layer/usecases/agent-harness-scans.ts` | One read of the intake rows, passed to the planner; one audit row per conflict. Nothing else moved. |
| `src/app-layer/usecases/agent-harness-matrix.ts`, `src/lib/agentic/harness-read-model.ts` | `ShadowRow.findingId` and `ShadowRow.intake`, each from one bounded read. |
| `src/app-layer/policies/agent-governance.policies.ts` | `meetsAgentGovernanceWrite`, the boolean `assertAgentGovernanceWrite` throws on. |
| `src/app-layer/usecases/agent-registration-intake.ts` | `canRunRegistrationIntake`, used by the usecase's own assertion and by the page; refusal sentences updated. |
| `src/app/t/[tenantSlug]/(app)/agents/reports/{page.tsx,ReportsClient.tsx}`, `harness/{HarnessTab,ShadowList}.tsx` | The permission and the action, threaded. |
| `harness/RegisterShadowAgentModal.tsx` | New. The intake dialog. |
| `src/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/{AiSystemDetailClient,ClassifyAiSystemModal}.tsx` | The Classify action and the new dialog. |
| `messages/{en,bg}.json` | `agents.harness.registerModal.*`, the shadow column's notes, `risks.aiSystems.detail.classify*`. |
| `tests/guards/agentic-route-inbound-links.test.ts` | The intake route now has a page caller, pinned by name. |
| `src/app/t/[tenantSlug]/(app)/vendors/[vendorId]/page.tsx`, `tasks/[taskId]/page.tsx`, `tests/guards/primary-{secondary-ratio,action-budget}.test.ts` | Two disclosure toggles demoted to secondary to pay for the two dialog submits; the per-file budgets lowered to the measurement. |
| `docs/agent-harness-contract.md`, `docs/agentic-iam-roadmap.md`, `CLAUDE.md` | The link rule and the shipped forms. |

## Decisions

- **The rule lives in the planner; the ingest only loads rows.** The intake
  claim is read in the ingest's transaction, keyed by `DiscoveredAgent.id`, and
  translated to `discoveredId` by `intakeClaimsByDiscoveredId`, which drops a
  row naming a discovered agent the ingest did not load. The ingest's query is
  tenant-filtered and runs under RLS, and the claim column has no FK, so the
  drop is the second wall a cross-tenant row would hit. #3721 (2c) landed first
  and edits the same function: its `invalidateRelinkedConfirmations` runs after
  the discovered-agent writes with the planner's link as `nextAgentId`, so an
  intake link applied or dropped is a move 2c sees, in the same transaction.
  The integration test drives a confirmation through both.
- **An unresolved claim is no claim.** The contract already said a claimed id
  the register does not hold "is treated as no link at all", so the intake
  applies to it as it applies to `null`. A claim the register DOES hold wins
  even against the intake's row, and is recorded as a conflict: the scanner may
  know something the intake did not, and the register keeps both facts.
- **Completeness gates the CLOSE, not the LINK.** The issue keeps "a scan closes
  the finding only on a complete read". Gating the link as well would flip the
  agent between linked and shadow on every incomplete scan, rewriting
  `registeredAgentId` and the shadow list each time, and would invalidate 2c's
  link confirmations as a side effect. So an incomplete scan links the agent and
  neither raises nor resolves its `SHADOW_AGENT`; the next complete one closes
  it. The reported-link path keeps its existing rule (the register's row exists
  or it does not, whatever the completeness). The two paths therefore differ on
  an incomplete scan; that is stated in the planner's header and in a test.
  **Owner decision (2026-10-18): keep the asymmetry.** A link the scanner
  reports closes `SHADOW_AGENT` on any scan; an intake link closes it only on a
  complete scan.
- **Linkable is an allowlist.** `DRAFT`, `ACTIVE`, `SUSPENDED`. RETIRED never
  links, and neither does a status a later migration adds, until someone lists
  it. A deleted row never links. The same predicate tells the shadow list whether
  an intake row is pending or spent.
- **The conflict is an audit row on the intake row, not a finding.** A finding
  would need its own close rule. The intake row's history is where somebody
  looking at a DRAFT agent that never got linked will look.
- **The Register action is shown where the intake would take it.** The page
  passes `canRunRegistrationIntake(ctx)`, which is the predicate the usecase's
  own assertion now calls, so the button and the server cannot disagree. A row
  with an intake row already made, of any status, offers no action, because the
  intake refuses a second one whatever the first one's status; the row says what
  became of it instead.
- **No owner reference crosses into the tab, so no suggestion is shown.** The
  matrix payload carries no owner reference by design (#3687, claim 6 of its
  integration test), and no attribution answer is stored anywhere a page can
  read: a `discovered-agent-review` run keeps its answer in its encrypted
  context, not in a structured row. So the tab supplies no suggestion and the
  dialog sends no `attribution`. The dialog does accept one, in the intake's own
  person-free provenance shape (status, grade, signal kinds and evidence
  pointers, never whom it named), and renders it read-only, so a later step that
  stores attribution answers has a place to put them. Nothing in that shape can
  reach the owner: the owner state has one writer, the picker.
- **The owner is confirmed per person.** The picker is `<UserCombobox>`, whose
  roster is `/users/assignable` (ACTIVE memberships only). The confirmation
  checkbox is disabled until someone is chosen, names that person, and is
  cleared when the choice changes. `intakeRequestBody` returns `null` without
  both, so the dialog has nothing to send.
- **No exposure axis is pre-selected.** The register's own form pre-selects the
  least-exposing value. For an agent nobody vouched for that would under-state
  its risk silently, so autonomy, data access, reversibility and provenance
  start unanswered. The AI-system role keeps the schema's `DEPLOYER` default.
- **The classify form has no blank answer.** Every question starts unanswered
  and "Does not apply" is an option of its own, sent as `null`. `answeredCount`
  drives both the disabled submit and `classificationRequestBody`, which returns
  `null` for a partial questionnaire.
- **Bundles.** The intake dialog is imported by `HarnessTab`, which
  `ReportsClient` already loads through `next/dynamic`, so the pack tab and the
  route's First Load JS carry none of it. The classify dialog is loaded through
  `next/dynamic` from the detail page, since only an unclassified entry opens
  it. Neither imports a usecase, `harness-contract` or anything else that reaches
  a Node built-in; the type imports are erased. The vendor list is read only
  when THIRD_PARTY is chosen, from `/vendors`.
- **The two dialog submits are paid for, not added.** `modal-action-order`
  makes each dialog's last action primary, and `primary-secondary-ratio` holds
  the product at 175 with no headroom. The vendor Documents tab's "add document"
  toggle and the task Links tab's "add link" toggle are disclosure toggles on
  screen with their own form's primary submit — the shape #3301 and #3687 demoted
  — so they are secondary now. The Classify trigger is a card action and is
  secondary. Net change to the measured total: zero.
- **2c's confirmation keys on the link this writes.** The service-principal
  confirmation (#3721) reads `DiscoveredAgent.registeredAgentId`, so an intake
  link is a link it can confirm, and a link the intake applies or drops is a move
  its invalidation sees. **Owner decision (2026-10-18): an intake does NOT
  count as that confirmation.** Confirming that a discovered principal is the
  agent's own stays its own deliberate act on the service-principal-link route,
  so this change writes no confirmation row and 2c needs no change for it.
