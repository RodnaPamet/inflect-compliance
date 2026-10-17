# 2026-10-17 — UNCLASSIFIED AI-system risk tier, read-only (2a deploy 1)

**Commit:** _(this PR)_ `feat(agentic): UNCLASSIFIED AI-system risk tier, read-only (2a deploy 1)`

## Design

Decision 1 of `docs/agentic-iam-roadmap.md` keeps the agent's AI-system link
required and has step `2a`'s registration intake (#3669) create a provisional
entry at a new `UNCLASSIFIED` tier. The column's `MINIMAL` default would claim a
classification nobody made, so the value is new rather than borrowed. It is not
a tier the Act defines and the classifier never returns it. It reaches the
column in two deploys (#3691):

```
                 deploy 1 (this PR)                    deploy 2 (#3669)
DB enum          UNCLASSIFIED added, sorted first  →   unchanged
readers          every one handles it              →   unchanged
writers          none — WRITERS = []               →   the registration intake
```

Two types now describe a tier, and the split is the design:

- `AiRiskTier` in `src/lib/eu-ai-act/classification.ts` stays the four tiers the
  Act defines. It is what `classifyAiSystem` returns and what
  `AiSystemRepository.create` accepts.
- `StoredAiRiskTier` is what the column can hold: those four plus
  `UNCLASSIFIED`. Readers are typed with it; `isClassifiedTier` narrows it back.

What each reader does with the value in this deploy:

- The AI-system register tones it `warning`, offers it as its own filter value,
  and counts it in the summary line (the clause appears only when the count is
  non-zero).
- The AI-system detail page replaces `{tier} risk · {clause}` with a
  not-classified line and shows a warning notice saying the entry carries no
  obligations and is not minimal-risk.
- Conformity drafting refuses it with its own reason.
- The agent detail header and the Overview tab render it as the existing
  "Unclassified" label. The agent register's badge takes its tone from the
  shared table.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | `UNCLASSIFIED` declared first in `AiRiskTier`, with a doc comment saying what it is and what it is not. |
| `prisma/migrations/20261017230000_ai_risk_tier_unclassified/migration.sql` | `ADD VALUE IF NOT EXISTS 'UNCLASSIFIED' BEFORE 'PROHIBITED'`, and nothing else. |
| `src/lib/eu-ai-act/classification.ts` | `AiRiskTier` stays the classifier's four; new `StoredAiRiskTier` and `isClassifiedTier`. |
| `src/lib/eu-ai-act/tier-display.ts` | New. `AI_ACT_TIER_TONE`, the one tone table, keyed exhaustively on `StoredAiRiskTier`; `aiActTierTone` answers `warning` for an unknown string, and every badge calls it. |
| `src/app-layer/repositories/AiSystemRepository.ts` | `create` takes the classifier's tier type, not the column's. |
| `src/app-layer/usecases/ai-system-conformity.ts` | Refuses an unclassified system before the not-HIGH check. |
| `src/app/t/[tenantSlug]/(app)/risks/ai-systems/filter-defs.ts` | `UNCLASSIFIED` as its own filter value, first. |
| `src/app/t/[tenantSlug]/(app)/risks/ai-systems/AiSystemsClient.tsx` | Tones through `aiActTierTone`; counts unclassified entries in the summary. Its exported `TIER_VARIANT` copy is gone. |
| `src/app/t/[tenantSlug]/(app)/risks/ai-systems/[systemId]/AiSystemDetailClient.tsx` | The not-classified meta line and notice; tones through `aiActTierTone`. |
| `src/app/t/[tenantSlug]/(app)/agents/AgentsClient.tsx` | Tones the EU AI Act badge through `aiActTierTone`. |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/AgentDetailClient.tsx` | Renders `UNCLASSIFIED` as "Unclassified". |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/OverviewTab.tsx` | The same, in the EU AI Act fact; the link to the AI system stays. |
| `messages/en.json`, `messages/bg.json` | `aiSystems.description` gains `{unclassified}`; `detail.notClassifiedLine`, `detail.notClassifiedNotice`; `filterEnums.riskTier.UNCLASSIFIED`. |
| `tests/guards/ai-risk-tier-unclassified-writers.test.ts` | New. One write seam (delegate, nested relation write or SQL text in any form), an empty `WRITERS`, every file that names the value listed as a reader with its reason, no Zod schema built from the generated enum, a closed census of the seam's methods, and type-level proofs on `create` and `linkRequirements`. |
| `tests/guardrails/enum-member-order-matches-migrations.test.ts` | `AiSystem.riskTier` joins `ORDINAL_SENSITIVE`: the register sorts on it, so its order may never be signed off. |

## Decisions

- **Two deploys, readers first.** A running container meets a stored value only
  if some row holds it, so this deploy adds the value and teaches every reader,
  and the next one adds the writer. By the time the intake can store
  `UNCLASSIFIED`, no container still running predates the code that reads it.
  Doing both in one deploy would also have been unsafe for a less obvious
  reason: the old readers' fallbacks misread an unknown tier rather than
  refusing it. Both tone tables fell back to
  `neutral`, which is MINIMAL's tone, and the conformity check would have
  refused the entry as "not HIGH-risk", a classification it never received.
  That is the `PROPOSE` lesson in CLAUDE.md: an unknown stored value falls
  through to the permissive branch, so the reader has to know the value before
  any row can hold it.
- **ADD VALUE only, and nothing else in the migration.** Renaming breaks a cast
  an old container still emits, because Prisma writes explicit enum casts into
  its SQL. That is the `@@map("WorkItem*")` lesson, where a renamed type fails
  old containers with SQLSTATE 42704. A value cannot be dropped without
  recreating the type, which is why `PROPOSE` is still in its enum. So an added
  value is permanent, and adding it was the decision to review, not a step that
  can be rolled back later. Postgres does not let a transaction use an enum
  value it added, so the migration contains the `ADD VALUE` and nothing that
  uses it. `IF NOT EXISTS` makes re-applying it harmless.
- **`BEFORE 'PROHIBITED'`, not appended.** Postgres orders an enum by its
  declared position, not alphabetically, and `AiSystemRepository.list` sorts on
  `riskTier asc`. An appended value would sort below `MINIMAL`, as if it were a
  tier lower than the lowest one. Placed first, the entries nobody has
  classified sit at the top of the register, where the remaining work is. The
  migration's position matches the declaration order in `enums.prisma`, so a
  database built by migrations and one built by `db push` agree. The filter
  lists the value first for the same reason.
- **The classifier's type stays at four, so `tsc` refuses the value.**
  `classifyAiSystem` returns the four-member `AiRiskTier` and
  `AiSystemRepository.create` now takes that type, not the Prisma column type.
  Neither the classifier nor the writer can produce `UNCLASSIFIED` without a
  diff that widens a type. The guard pins that with a type-level proof: if
  `create`'s tier parameter ever admits `'UNCLASSIFIED'`, `Proof` becomes
  `never` and `npm run typecheck` fails. The library type keeps the name it
  shares with Prisma's enum so the classifier's callers are untouched; the
  repository imports it under the alias `ClassifiedAiRiskTier`.
- **One writer, and a `WRITERS` list that is empty on purpose.**
  `AiSystemRepository` is the only file that writes `AiSystem` — through a
  delegate, a nested write on either relation that reaches it (`aiSystem` on an
  agent, `aiSystems` on a tenant), or SQL text that inserts into or updates the
  table, wherever that text is built. The guard looks for all three because the
  intake is likely to create the AI system nested inside the agent, a shape a
  delegate-only scan does not see. It also refuses a Zod schema built from the
  generated enum: a request body validated by one could hand a writer the value
  without any file naming it, which is the one way past the naming check. Its one `create` serves both callers by way of
  `authorAiSystemEntry` (the AI-system register and `registerAgent`), and it
  does not name the value. Every other file that names `UNCLASSIFIED` in code is
  on `READERS`, with the reason it names it, and a new one fails until somebody
  says whether it reads or writes. In this deploy the empty `WRITERS` list is
  the property itself. #3669 amends the guard: its intake joins `WRITERS` in
  the same pull request, and the "no writer in this deploy" assertion goes with
  it.
- **One tone table for both registers.** The AI-system register and the agent
  register each had their own copy of the tier-to-tone map, so a value added to
  the column had to be added twice, and a copy that missed it would render the
  value neutral. `AI_ACT_TIER_TONE` is now the only table. Keyed exhaustively on
  `StoredAiRiskTier`, it turns a missing tone into a compile error, and it
  carries tones only, with no UI import, so `src/lib` does not depend on a
  component. `UNCLASSIFIED` is `warning` because the point of the value is that
  the entry is not known to be minimal. Every badge calls `aiActTierTone`
  rather than indexing the table with a `?? 'neutral'` fallback, so a value a
  container does not know yet is a warning there too, never MINIMAL's tone.
- **The tier's order is now load-bearing, and the order guard says so.**
  `AiSystem.riskTier` is on `ORDINAL_SENSITIVE` in
  `enum-member-order-matches-migrations.test.ts`, so a later migration that
  disagrees with the schema's order cannot be signed off: unclassified entries
  head the register only while the type puts them first.
- **The agent views render it as "Unclassified", not as a tier.** The agent
  detail header and the Overview tab print the Act's tier as a bare literal
  beside the agent's own operational tier, and the two taxonomies already share
  `HIGH`. Printing `UNCLASSIFIED` there would look like a fifth classification.
  Those surfaces already have words for "no AI Act classification", the
  catalogue's "Unclassified" used when there is no tier. A provisional entry is
  that same state, so it gets the same words: one state, one rendering. The
  link to the AI system stays, because that page is where somebody classifies
  it. The AI-system register is different: it shows the stored value as its
  own badge, because there the value is the column's own and filterable.
- **Conformity drafting refuses with its own reason, checked first.** "Only
  generated for HIGH-risk AI systems" would tell the operator the system had
  been found not high-risk. The new refusal says it has not been classified and
  what to do about it.
- **The register's description changed with the count.** "Each classified
  against the EU AI Act" would be false the day the intake writes a row, so it
  now reads "Each classified system is mapped to the obligations its … tier
  carries". The `{unclassified}` clause renders nothing at zero, which is every
  tenant in this deploy.
- **The column default stays `MINIMAL`.** A default naming `UNCLASSIFIED`
  would make the database a writer of the value in the deploy that has none,
  and the one writer always passes a tier anyway.
