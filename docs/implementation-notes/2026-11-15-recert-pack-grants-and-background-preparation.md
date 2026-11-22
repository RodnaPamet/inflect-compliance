# 2026-11-15 — Agent recertification: a smaller grant section, and large campaigns off the request

**Commit:** see the branch `claude/recert-pack-cap-and-flags-5317` (#5317, owner decision of 2026-11-15: "shrink grants + async")

## Design

The 2026-11-14 change left `PACK_PAGE_SIZE` at 1, because one agent with every
section at its cap sealed at ~239,900 bytes of a run's 262,144, ~178 KB of it
the grant section. Two changes follow from the owner's decision.

**1. The grant section.**

- `GRANTS_PER_AGENT` 200 → 100, and the grant read is now PER AGENT, read one
  past the cap, like the time-bounded and kill reads. The shared page read
  (`pageSize × cap + 1` rows) let one agent with many grants mark every agent
  on its page truncated, and a truncated subject plans no narrowing; with two
  agents a page that became reachable.
- A granted tool's name is carried at most `TOOL_NAME_IN_PACK` (64) characters
  (`packToolName`). A cut name is flagged `toolNameTruncated: true`, written
  only when true, optional with no default, so a pack filed before it re-parses
  to the sections it was hashed over (pinned hash in
  `tests/unit/agent-recertification.test.ts`, computed under the module as it
  stood at 1cab6b8d4 and checked equal under this one).
- The full name stays in the store. A narrowing row is written with the stored
  name (`fullToolNameFor`), read by the grant id the pack names, and only when
  the pack's name is that name cut — so what a reviewer accepts and what the
  revocation records name the tool whole.

- A time-bounded grant's connection name is carried at most
  `CONNECTION_NAME_IN_PACK` (64) characters (`packConnectionName`, second
  owner decision of 2026-11-15), flagged `connectionNameTruncated: true` the
  same way. Nothing reads the name back from a pack; the journal keeps it
  whole. Both bounds count CODE POINTS, so a cut never leaves half a surrogate
  pair, which Postgres refuses in a `jsonb` column.

Measured by `tests/unit/agent-recertification-pack-budget.test.ts`, with tool
names ASCII and connection names two bytes a character (Cyrillic):

| | bytes sealed |
| --- | --- |
| one worst agent | 112,969 |
| two worst agents | 225,378 |
| budget (cap less 10% headroom) | 235,929 |
| two worst agents, connection names in emoji (4 B a character) | 250,978 (under the cap, over the budget) |
| three worst agents | over the cap |
| one agent with no grants | 57,949 |

| section (one agent, at its cap) | rows × worst row | bytes |
| --- | --- | --- |
| grants | 100 × ~297 (five carry counts, ~401) | ~30.3 KB |
| their narrowings (in the plan) | 100 × ~246 | ~24.7 KB |
| time-bounded grants | 100 × ~387 | ~38.8 KB |
| card versions | 50 × ~243 | ~12.2 KB |
| kill engagements | 25 × ~184 | ~4.6 KB |

So `PACK_PAGE_SIZE` = 2. The test derives the largest page that fits the
budget and requires it to equal the constant.

**2. Large campaigns off the request.**

```
POST …/agent-packs ── requestAgentReviewPacks
   │  readPreparationHead: every refusal (person, admin tier, OPEN AGENT campaign,
   │  preparer named, no packs, population, both preparers eligible)
   ├─ runs ≤ SYNC_PACK_RUN_LIMIT (5) → prepareAgentReviewPacks inline → 201
   └─ runs > 5 → enqueue('agent-recert-packs-prepare', {tenantId, accessReviewId,
                 requestedByUserId, requestId}, {jobId: agent-recert-packs-<id>}) → 202
                     │   (a live job with that id is joined; a failed one removed first)
                     ▼
   worker ── runAgentRecertPackPreparation (runJob)
        resolveInitiatorContext(requester) — null ⇒ REQUESTER_NOT_AUTHORISED
        access_reviews.create? — no ⇒ REQUESTER_NOT_AUTHORISED
        prepareAgentReviewPacks(ctx, id, { onProgress → job.updateProgress })
           (readPreparationHead again: every refusal re-asked)
        a refusal ⇒ one ACCESS_REVIEW_AGENT_PACKS_REFUSED audit row {reason: CODE},
           as the requester if they resolved, else the tenant system job; job fails
        metric agentic.recert_pack_preparation.outcome {prepared|refused|error, job}

GET …/agent-packs ── packs + (no packs yet ? readAgentPackPreparation : null)
        QUEUED/RUNNING {done, total} | FAILED {reason} | UNKNOWN | null
page ── polls every 3 s while QUEUED/RUNNING; "Preparing reviewer packs… N of M agents";
        re-reads the campaign when the preparation ends
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-recertification.ts` | `PACK_PAGE_SIZE` 2 with the arithmetic; `TOOL_NAME_IN_PACK`, `packToolName`, `fullToolNameFor`; `toolNameTruncated` |
| `src/app-layer/usecases/agent-recertification-evidence.ts` | `GRANTS_PER_AGENT` 100; per-agent grant read; names cut and flagged |
| `src/app-layer/usecases/access-review-agent.ts` | `readPreparationHead`; progress; narrowing written with the stored name; `requestAgentReviewPacks`, `readAgentPackPreparation`, `prepareAgentReviewPacksForRequester` |
| `src/app-layer/jobs/agent-recert-pack-preparation.ts` | the job body, as the requester |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts` | payload, defaults (one attempt), registration with progress |
| `src/lib/observability/integration-metrics.ts` | `recordAgentRecertPackPreparation` |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/agent-packs/route.ts` | 201 / 202; `preparation` on GET |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | progress, failure and unknown notices; polling |
| `messages/en.json`, `messages/bg.json` | four strings |

## Decisions

- **The job runs as the requester, re-read** (`resolveInitiatorContext`, the
  helper for "a job that does what one named member asked for": the membership
  now, custom role included, soft-deleted workspace refused). Never a system
  context: a refusal fails the job and writes nothing.
- **Every refusal is asked twice, by one function.** `readPreparationHead` is
  called by the request before it enqueues and by `prepareAgentReviewPacks`
  when the job runs, so the two cannot drift. The job adds the route's key
  (`access_reviews.create`), which no route asks for it.
- **A refusal is audited once, with its code.** `ACCESS_REVIEW_AGENT_PACKS_REFUSED`
  names the campaign, the refusal code, the requester's id and whom the row is
  attributed to, and no free text. The row is the requester's re-read
  context's when it resolved, and the tenant system job's
  (`buildTenantSystemJobContext`, the `sys_<tenantId>` principal) when it did
  not: a person who left is not borrowed to sign for their own refusal. The
  head's two uncoded refusals are named `CAMPAIGN_NOT_FOUND` and
  `REQUESTER_NOT_ADMIN`. A fault that is not a refusal writes no row.
- **One attempt.** Every refusal the job can reach is terminal, and a retry
  would start every page's workflow run again. The page shows the failure and
  the next press removes the failed job before queueing.
- **A fixed job id per campaign** (`agent-recert-packs-<reviewId>`) dedupes a
  second press and lets the page find the job without being told its id. The
  job lookup (`findTenantJob`) answers only for the caller's tenant.
- **The queue is read only while there are no packs.** A queue that cannot be
  read is `UNKNOWN`, never "none": "none" would offer Prepare over a
  preparation that may be running. A failure's reason is shown only when it
  is one of the usecase's refusal sentences (`CODE: detail`).
- **What the budget assumes of a character.** Two worst agents are 10,551
  bytes inside the 10% line with two-byte connection names, 23,351 with ASCII
  ones. Four-byte labels (emoji) put a page over the budget but under the cap,
  which the budget test holds. A label of control characters or lone
  surrogates, which JSON writes as six-byte escapes, would not fit; no code
  bounds that, and the test says so.
