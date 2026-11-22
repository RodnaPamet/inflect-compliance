# 2026-11-20 — Agent Pay Phase 1 remainder: routes, register card, inventory row, pack section

**Commit:** see the pull request for #5333.

## Design

Phase 1 of `docs/ai-architecture/mastercard-agent-pay.md` built
`AgentSpendingAuthority` and its one writer
(`usecases/agent-spending-authority.ts`) on 2026-11-11, with nothing that
called the writer but tests and the kill switch. This change gives the writer
its surfaces and carries the envelope into the two places that report on
agents.

```
agent page (Overview)                 routes (admin.agent_registry)              writer (unchanged rules)
SpendingAuthorityCard ── GET ───────▶ …/spending-authority ──────────────────▶ getAgentSpendingAuthorityState
                       ── POST ──────▶ …/spending-authority ──────────────────▶ declareAgentSpendingAuthority
                       ── PATCH ─────▶ …/spending-authority/:rail ────────────▶ narrowAgentSpendingAuthority
                       ── DELETE ────▶ …/spending-authority/:rail ────────────▶ withdrawAgentSpendingAuthority
                       ── POST ──────▶ …/spending-authority/:rail/review ─────▶ reviewAgentSpendingAuthority

governance pack: agent inventory   ── reads AgentSpendingAuthority (not WITHDRAWN): rail, status, review
AGENT campaign: reviewer pack      ── reads AgentSpendingAuthority: one entry per rail, in sectionsJson
```

`getAgentSpendingAuthorityState` is a read in the writer's file: the envelopes,
and for each the acts THIS viewer would be allowed, decided by the same rules
the writers apply, in the same order (the agent-governance floor, a person,
the agent not retired, the status, the declarer, the owner at declaration or
now). The card ANDs those answers with the page's edge-aware register gate and
computes nothing itself. A withheld review carries its reason, so the card can
say "you declared this" rather than hide a button.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-spending-authority.ts` | `getAgentSpendingAuthorityState`: the card's read, with per-envelope affordances |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/spending-authority/**` | GET and declare; narrow and withdraw by rail; review by rail |
| `src/lib/security/route-permissions.ts` | The explicit `admin.agent_registry` rule, above the register's catch-all |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/SpendingAuthorityCard.tsx` | The card and its declare / narrow dialog |
| `src/app-layer/usecases/agent-governance-reports.ts`, `src/lib/agentic/report-definitions.ts`, `src/lib/agentic/pack-document.ts` | The inventory row and its two defined counts |
| `src/lib/agentic/agent-recertification.ts`, `src/app-layer/usecases/agent-recertification-evidence.ts` | The pack's optional `spendingAuthority` section |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | The pack column's one-line summary of it |

## Decisions

- **The routes take `admin.agent_registry`, as the issue says**, stated in an
  explicit route rule rather than inherited from the catch-all. The four-eyes
  rule stays in the writer and its CHECK; no second key.
- **A PATCH body naming a rail other than the path's is a 400**
  (`RAIL_MISMATCH`), never a narrowing of a different envelope than the URL
  names.
- **The inventory row carries rail, status and review only.** Amounts,
  merchants and the token reference stay on the register page, under the
  register key; the pack is read under the inventory gate and filed as
  evidence. `inventory.agents_with_spending_authority` counts envelopes not
  WITHDRAWN; `…_unreviewed_…` uses the activation rule (DECLARED, or
  SUSPENDED_REQUESTED with no review). Neither claims an agent cannot pay:
  discovery is the harness's `SPENDING_AGENT_UNDECLARED`.
- **The pack section counts the merchant lists and leaves the token reference
  out.** The section reaches the model that prepares the pack; a reviewer needs
  the width of the scope, not the host names, and never the third party's
  identifier. It is read as it stands at preparation, like the breaker: an
  envelope is a standing privilege, not an event in the window.
- **The section is optional with no default**, for the reason
  `timeBoundedTruncated` gives: a pack filed before it must re-parse to the
  sections it was hashed over. Absent means "predates the section"; `[]` means
  "the register records none".
- **It costs about 2.6 KB per agent at worst** (three rails, longest platform
  name). `PACK_PAGE_SIZE` stays 2; the worst page seals at 230,630 bytes,
  inside the 235,929 budget by 5,299. The budget test models the section.
- **3.3 comes with it.** The section is in `sectionsJson`, whose `contentHash`
  the campaign's closing evidence carries, so the evidence hash covers it and
  an auditor recomputes it from the stored row.
- **One new primary, paid for.** The dialog's save is the last action of a
  Modal, which `modal-action-order` requires to be primary; the policy page's
  next-review-date inline save (an xs field-level edit) was demoted to pay for
  it, as the ratchet's history requires.

## Not built: the narrowing half of 1.4

The roadmap says a pack's narrowing "may propose reducing or withdrawing the
envelope", and accepting it writes the declaration and opens a task. That is
not built, because it rests on decisions the roadmap leaves open:

1. **On what evidence does a pack propose it?** A grant narrowing has one
   basis, a grant held for the whole window and never called. No spend is
   observed before Phase 4, so the candidates are register facts: an envelope
   expired by the window's end, one still SUSPENDED_REQUESTED after a kill, one
   never reviewed, or an agent the harness does not see as payment-capable.
   Which of these, if any, is an owner decision.
2. **What is a "reduction"?** The plan is re-derived from stored rows and the
   pack is prepared by an agent, so a proposed lower limit would have to be a
   rule, not a judgement. Withdrawal is derivable; a reduction is not without
   one.
3. **Under which key is it accepted?** A campaign's narrowing is accepted under
   `access_reviews.decide`. The envelope's writer takes `admin.agent_registry`.
   Letting the campaign write it is the "every effect takes authority away"
   argument the retirement cascade made, but it is a permission decision.
4. **Schema.** `AccessReviewAgentNarrowing` names a grant (`grantId`,
   `toolName`, not null, unique per pack) and one basis. A spending narrowing
   is either a second table or a kind column with nullable grant fields and
   CHECKs, with its one-way triggers either way, and the campaign file's
   pinned write set (`agent-recertification-single-write-seam`) widened to
   call the envelope's writer.

Until those are answered, a reviewer who would reduce or withdraw an envelope
does it on the agent's page; the access-review guide says so.
