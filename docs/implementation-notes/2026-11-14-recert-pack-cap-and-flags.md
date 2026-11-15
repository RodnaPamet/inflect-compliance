# 2026-11-14 — Agent recertification pack: caps, kill flag, page size

**Commit:** see the branch `claude/recert-pack-cap-and-flags-5317` (#5317, owner decisions of 2026-11-14)

## Design

Three owner decisions on the reviewer pack, following #5646:

1. `TIME_BOUNDED_PER_AGENT` 25 → 100.
2. The kill-engagement section is read per agent, capped at `KILLS_PER_AGENT`
   (25), read one past the cap, with a per-subject `killsTruncated` flag. A kill
   still in force is read first, then the most recently lifted; the section is
   shown oldest first as before. `killsTruncated` is `z.boolean().optional()`
   with no default, so a pack filed before it re-parses to the sections it was
   hashed over (pinned hash in `tests/unit/agent-recertification.test.ts`).
3. The access-review page notes each capped section (`grantsTruncated`,
   `timeBoundedTruncated`, `killsTruncated`) under the subject's pack summary.

A pack run holds its page's evidence and the plan built from it in its sealed
context, refused over `MAX_CONTEXT_BYTES` (262,144). The worst agent, every
section at its cap and every row at its largest, seals at about 239,900 bytes;
two seal at about 479,300. So `PACK_PAGE_SIZE` went from 20 to 1.
`tests/unit/agent-recertification-pack-budget.test.ts` seals the worst page
with the engine's own `sealContext` and fails if it does not fit, or if a page
one larger would.

| section (one agent, at its cap) | rows × worst row | bytes |
| --- | --- | --- |
| grants | 199 × ~511 | ~101.7 KB |
| their narrowings (in the plan) | 199 × ~383 | ~76.2 KB |
| time-bounded grants | 100 × ~429 | ~42.9 KB |
| card versions | 50 × ~243 | ~12.2 KB |
| kill engagements | 25 × ~184 | ~4.6 KB |
| everything else | | ~1.8 KB |

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-recertification-evidence.ts` | caps exported; per-agent kill read and flag |
| `src/lib/agentic/agent-recertification.ts` | `killsTruncated`; `PACK_PAGE_SIZE` = 1 with the arithmetic |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | capped-section notes |
| `messages/en.json`, `messages/bg.json` | three note strings |

## Decisions

- The page size is set by the grant section, not by the time-bounded raise:
  without it an agent is about 61 KB and four would fit. Lowering
  `GRANTS_PER_AGENT`, or bounding tool names, would raise the page size; that
  is the owner's call and is not made here.
- A page of one makes a preparation one synchronous run per agent inside the
  request (about 250 ms a run locally), up to 500 for the largest campaign.
- The connection name on a time-bounded grant has no length bound at the API;
  the budget assumes 200 bytes.
