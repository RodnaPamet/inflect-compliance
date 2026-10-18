# 2026-10-18 — AGENT access-review scope, read-only (3a deploy 1)

**Commit:** _(this PR)_ `feat(agentic): AGENT access-review scope, read-only (3a deploy 1)`

## Design

Step `3a` (#3674) recertifies registered agents through the access-review
campaigns that already recertify memberships, directory accounts and legacy
applications. Its subjects need a scope value, and the value reaches
`AccessReviewScope` in two deploys, as `UNCLASSIFIED` reached `AiRiskTier`
(#3696):

```
                 deploy 1 (this PR)                         deploy 2 (#3674)
DB enum          AGENT appended                        →   unchanged
readers          every one handles it                  →   unchanged
acting paths     create / decide / close refuse        →   the agent campaign's own
                 AGENT_CAMPAIGN_NOT_AVAILABLE               create, decide, close
writers          none — WRITERS = []                   →   the campaign usecase
```

The reason is not caution in the abstract. A Prisma client that meets an enum
value it was not generated with fails the read, and the register lists every
campaign of the tenant in one query — so a single AGENT row read by an old
container would take the whole access-review surface down, not one campaign.
By the time deploy 2's writer stores the value, every container still running
has this build's readers.

What each reader does with the value in this deploy:

- **The scope facts** live in `src/lib/access-review/scope.ts`, client-safe:
  the stored scope list, the member scopes, `SUBJECT_TABLE` (which decision
  table holds a scope's subjects — AGENT is `CONNECTED`), the label key, the
  agent subject shape and the read rule for it.
- **The close route** dispatches on `subjectTableOf(scope)`. It named
  CONNECTED_APP and LEGACY_APP and sent anything else to the member close.
- **Both closes and the connected decide** refuse AGENT by name through
  `assertNotUnimplementedAgentCampaign`
  (`usecases/access-review-scope-gate.ts`). The member close also refuses every
  non-member scope.
- **The member creation route** accepts the member scopes only, with a named
  message for each other scope.
- **The create seam** excludes AGENT by type and at run time.
- **Subject reads** (`getAccessReview`, `getAccessReviewWithActivity`,
  `listConnectedDecisions`) withhold an AGENT campaign's subject data from
  anyone who is neither its reviewer nor a holder of `admin.agent_registry`.
- **The detail page** renders AGENT subjects in their own table — agent, owner,
  grant count, decision — read-only, with a notice; the register labels every
  scope through `accessReviews.scopeLabels` and counts subjects in both tables.
- **The reminder and overdue-escalation jobs and the calendar loader** already
  sum both decision tables and never branch on scope, so they read AGENT as it
  is. No change.
- **The evidence PDF** prints the scope as a string. Only a close reaches it,
  and both closes refuse AGENT here.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | `AGENT` appended to `AccessReviewScope`, with what it is and why it is two deploys. |
| `prisma/migrations/20261018130000_access_review_agent_scope/migration.sql` | `ADD VALUE IF NOT EXISTS 'AGENT'`, and nothing else. |
| `src/lib/access-review/scope.ts` | New. The scope list, member scopes, `SUBJECT_TABLE`, `subjectTableOf`, `scopeLabelKey`, `AGENT_CAMPAIGNS_IMPLEMENTED`, `AgentSubjectSnapshot`, `readAgentSubjectSnapshot`, `mayReadAgentSubjects`. |
| `src/app-layer/usecases/access-review-scope-gate.ts` | New. The one named refusal, `AGENT_CAMPAIGN_NOT_AVAILABLE` (409). |
| `src/lib/errors/types.ts` | `AGENT_CAMPAIGN_NOT_AVAILABLE` joins `DomainErrorCode`. |
| `src/app-layer/schemas/access-review.schemas.ts` | `scope` is `z.enum(MEMBER_ACCESS_REVIEW_SCOPES)` with a named message per non-member scope. |
| `src/app-layer/repositories/AccessReviewRepository.ts` | `create` takes `WritableAccessReviewScope` and refuses AGENT at run time; the membership resolver takes member scopes; the list counts connected subjects too. |
| `src/app-layer/usecases/access-review.ts` | `narrowAgentSubjects` on both detail reads; the member close refuses non-member scopes. |
| `src/app-layer/usecases/access-review-connected.ts` | The decide and the close refuse AGENT; the subject list narrows like the detail; the remediation wording has an agent case. |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/close/route.ts` | Dispatches on the subject table. |
| `src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx` | Scope label through i18n; progress over both subject tables. |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | The agent subject table, read-only notice and restricted notice; no decide or close for AGENT. |
| `messages/en.json`, `messages/bg.json` | `accessReviews.scopeLabels.*`, the agent columns and notices. |
| `docs/agentic-audit-procedures.md` | The recertification-completeness exclusion no longer says the scope has no agent value. |
| `tests/guards/access-review-agent-scope.test.ts` | New. One create seam, no scope rewrite, no Zod schema from the generated enum, every access-review file naming AGENT a listed reader, an empty `WRITERS`, and type-level proofs. |

## Decisions

- **Refuse, not "handle", on the acting paths.** The member close has no
  zero-subject guard, and the connected decide does not know that an agent's
  owner may not decide their own agent. A deploy-1 container serving a
  decide or a close during deploy 2's rollout would apply the wrong rules to
  the first real AGENT campaign, so each refuses by name. 409, not 400: the
  request is well formed and conflicts with this build.
- **A flag and an empty list, both.** `AGENT_CAMPAIGNS_IMPLEMENTED` is the
  brake the acting paths read, in the shape of `DIRECTION_IMPLEMENTED`;
  `WRITERS` is the census the guard holds. Deploy 2 changes both in one
  reviewed diff.
- **The member route stops accepting CONNECTED_APP and LEGACY_APP too.** A
  member campaign stamped with either snapshotted memberships into a campaign
  whose close and detail page read the other table, so it could never be
  closed. Narrowing the schema to the member scopes is what refuses AGENT
  without the file naming AGENT for every reader, and it fixes those two for
  the same price.
- **Subjects narrow to the reviewer or a register reader.** Every role holds
  `access_reviews.view`; the agent register is read under
  `admin.agent_registry`. The roadmap narrows the pack read that way, and an
  agent subject row carries the same register data, so the read narrows the
  same way now: deploy 2's rows are first read by this build.
- **An unknown scope routes to the connected close.** It refuses zero subjects
  and a pending subject; the member close would close over zero member rows
  and produce evidence that nobody was reviewed.
- **Appended, not inserted.** Nothing sorts on `scope`, so the value goes last
  and the migration's order matches the declaration order.
- **The LEGACY_APP detail page is untouched.** It renders legacy subjects from
  the member table, which is empty for them — a defect this branch observed and
  did not change, because its connected-table columns describe directory
  accounts, and choosing columns for a legacy account is that page's own fix.
