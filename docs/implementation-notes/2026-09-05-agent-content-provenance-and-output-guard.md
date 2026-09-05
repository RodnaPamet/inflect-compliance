# 2026-09-05 — Agent content provenance + the agentic output guard

**Commit:** `990fff796` feat(agentic): tag the agent's corpus and quarantine an injected proposal

## Design

Three seams, and only the third one refuses anything.

```
  ┌──────────────────────────────────────────────────────────────────┐
  │  READ  — src/lib/mcp/tools/registry.ts::runReadTool               │
  │                                                                   │
  │   usecase → redact → audit → APPEND a provenance envelope         │
  │                               (content[1], never wrapping [0])    │
  │                                                                   │
  │   provenanceOfTool(name) → TENANT_AUTHORED | THIRD_PARTY_INGESTED │
  │                          | SYSTEM   … unknown ⇒ untrusted         │
  └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼   (the agent reasons; we cannot see it)
  ┌──────────────────────────────────────────────────────────────────┐
  │  PROPOSE — usecases/agent-proposals.ts::createAgentProposal       │
  │                                                                   │
  │   validate → sanitise → guardAgentProposal(pure)                  │
  │                            │                                      │
  │              CLEAN/FLAGGED │ QUARANTINED                          │
  │                            ▼                                      │
  │              status PENDING│status QUARANTINED  (row still WRITTEN)│
  │              + guardVerdict / guardRuleIds / guardInputDigest      │
  │                / guardProvenance on the row                       │
  │              + one AiDecisionLog row (digest, bounded summary)     │
  └──────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │  REVIEW — listAgentProposals / approve / reject                   │
  │                                                                   │
  │   QUARANTINED is absent from the queue AND refused by the usecase │
  │   (403 + one hash-chained AUTHZ_DENIED row). Terminal.            │
  └──────────────────────────────────────────────────────────────────┘
```

**The gap this closes.** `createAgentProposal` already called
`guardUntrustedInput`. It could not refuse with it. That helper resolves
enforcement through `TenantSecuritySettings.aiGuardMode`, whose default is
`BALANCED`, and under `BALANCED` a **malicious** input verdict resolves to
`flag` — which `assertGuardAllowed` does not throw on. So a proposal whose own
text tripped a high-severity injection rule was written as an ordinary
`PENDING` row and reached the reviewer's queue looking exactly like a clean
one. The human was the only control, and the human was told nothing.

**Provenance is what lets one scan give two answers.** The same sentence is an
injection in an uploaded PDF and IC's own prompt in the platform's scaffolding.
`mayCarryInstruction(provenance)` is the only thing that separates them, and it
returns true for `SYSTEM` alone. `guardAgentProposal` reads that, not the
tenant's appetite, which is why a tenant in `audit` mode still cannot switch
quarantine off — the mode governs whether IC will call a MODEL, not whether
untrusted text may become a compliance record.

**The corpus.** `tests/integration/prompt-injection-corpus.test.ts` plants each
payload where that kind of content really lands (evidence row, questionnaire
answer, synced ticket, policy, task comment, scanner finding, risk description
returned by `list_risks`) and then assumes the agent is **fully compromised**:
it submits, through the real `propose_risks` tool, exactly what the agent would
submit if it had obeyed. Nothing depends on a model resisting. Adding a case is
one entry in `tests/fixtures/prompt-injection-corpus.ts`.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/content-provenance.ts` | NEW. The three labels, the fail-closed allowlist (`resolveContentProvenance`), `mayCarryInstruction`, `leastTrusted`, the per-tool corpus map (`MCP_TOOL_CORPUS`), and the envelope builder. Pure — no I/O, no Prisma. |
| `src/app-layer/ai/guard/proposal-guard.ts` | NEW. `guardAgentProposal` — pure verdict from `scanInjection` + `scanEgress` + provenance. `computeProposalDigest`, `summarizeWithoutContent`. |
| `src/app-layer/ai/guard/patterns.ts` | One new HIGH rule, `inj.exfil.markdown_image_beacon` — a markdown IMAGE whose URL carries a data-bearing query string. |
| `src/lib/mcp/tools/registry.ts` | `runReadTool` appends the provenance envelope as a second content block. |
| `src/lib/mcp/tools/propose-tools.ts` | `runProposeTool` reports queued and quarantined counts separately. |
| `src/app-layer/usecases/agent-proposals.ts` | Guard wiring, the four new columns, the `AiDecisionLog` row, `refuseQuarantined`, `NON_REVIEWABLE_STATUSES`, `listQuarantinedAgentProposals`, approve/reject refusal. |
| `src/app-layer/usecases/assistant.ts` | `proposalMessage` — stops the assistant claiming a quarantined proposal is "queued for review". |
| `prisma/schema/enums.prisma` | `AgentGuardVerdict`, `AgentContentProvenance`, and `QUARANTINED` on `SuggestionItemStatus`. |
| `prisma/schema/agentic.prisma` | Four columns + `@@index([tenantId, guardVerdict, createdAt])` on `AgentProposal`. |
| `prisma/migrations/20260905140000_agent_proposal_output_guard/` | The migration. No RLS work — `AgentProposal` already carries the policy triple. |
| `tests/fixtures/prompt-injection-corpus.ts` | The corpus data: one case per technique, plus the clean control. |

## Decisions

- **No new model.** The spec's shape was `AiDecisionLog`'s three properties on
  the agentic path. A dedicated `AgentProposalGuardLog` would have cost an RLS
  policy triple, an `ISOLATION_TESTED` entry, a retention-inventory row, an
  encryption-manifest classification and a two-tenant behavioural test — to
  store a verdict that has to live on `AgentProposal` anyway, because
  `approveAgentProposal` must refuse without a join. So the verdict is four
  columns on the row, and the AI-ops record is a real `AiDecisionLog` row with
  `feature: 'agent-proposal'`. The two share a digest, so they join.

- **`QUARANTINED` on the shared `SuggestionItemStatus`, not a new enum.**
  `RiskSuggestionItem` uses the same enum and never writes the value; the
  alternative was changing a live column's type, which is a rewrite.
  `ALTER TYPE … ADD VALUE` is the additive, rolling-deploy-safe half of the
  hazard the `@@map("WorkItem*")` pins record.

- **A quarantined proposal is WRITTEN, not thrown.** The earlier behaviour on a
  strict-mode block was to throw and persist nothing. The row is the only
  durable evidence the attempt happened; an operator triaging an injection needs
  to see what was tried, not an error somebody's agent swallowed. It is also why
  the batch reports two counts instead of failing whole.

- **The refusal is at the usecase, and it refuses REJECT too.** A list filter
  hides a row from one surface; every other caller walks past it. Reject is
  refused as well because moving the row to `REJECTED` would take it out of the
  triage listing — "dispose of it" and "hide the evidence" would be the same
  click.

- **Quarantine is terminal with no override, and the false positive is the
  price.** A legitimate proposal that trips a high-severity rule cannot be
  approved. The payload stays on the row, so a human can read it and create the
  record themselves — at which point the content is tenant-authored, which is
  the right outcome rather than a workaround. An "approve anyway" flag would
  make the guard a speed bump.

- **The envelope is appended, never wrapped.** `content[0]` stays the exact JSON
  every existing agent and test parses. The banner is advisory — a model can
  ignore it — and saying so plainly matters: the load-bearing control is the
  propose seam, which asks the model nothing.

- **The summary is structural, not an excerpt.** `AiDecisionLog.outputSummary`
  stores a sanitised slice of a model's answer, which is safe there because the
  answer is IC's own prose. Here the "output" IS the untrusted content, so a
  slice would persist exactly the payload the guard exists to keep out. It
  records the kind, the field names, the character counts and the rule ids.

- **`listAgentProposals` parses `?status=` against the REVIEWABLE vocabulary**,
  so `?status=QUARANTINED` is a 400 rather than a way in, and it names that set
  even when no filter is supplied. `NON_REVIEWABLE_STATUSES` is subtracted from
  the live enum, so a new REVIEW state appears in the queue by default while a
  new REFUSAL state has to be declared.

- **A new HIGH exfil rule rather than escalating a MEDIUM one.** The existing
  `inj.exfil.render_remote` is deliberately tempered because a bare
  `![logo](https://cdn/x.png)` is an image. An image URL carrying `?k=<value>`
  exfiltrates on RENDER with no click and no tool call; requiring the query
  string is what makes the stricter rule specific enough to be high severity.
