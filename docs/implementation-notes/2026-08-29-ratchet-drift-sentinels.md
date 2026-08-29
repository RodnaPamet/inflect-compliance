# 2026-08-29 — re-seat drifted guard baselines, add drift sentinels

**Commit:** `<sha> fix(guards): re-seat four drifted baselines and give each a drift sentinel`

## Design

A count ratchet ("no more than N occurrences of X") asserts only `live <= baseline`.
That check is silent in the other direction: when the tree improves and nobody lowers
the baseline, the gap becomes headroom a future regression can spend with a green
build. Nothing reports it, because the ratchet is passing the entire time.

Four guards had drifted:

| guard | constant | was | live | slack |
| --- | --- | --- | --- | --- |
| `guardrails/raw-color-ratchet` | `BASELINE` | 95 | 51 | 44 |
| `guardrails/table-platform-drift` | `RAW_TABLE_BASELINE` | 15 | 11 | 4 |
| `guards/epic52-datatable-ratchet` | `RAW_TABLE_BASELINE` | 12 | 9 | 3 |
| `guards/border-tone-budget` | `BORDER_DEFAULT_BUDGET` | 114 | 111 | 3 |

Each is re-seated to its live count, and the stale "hotspot" enumerations — which
described trees several migrations out of date — are replaced with verified lists.

The shared sentinel lives at `tests/helpers/ratchet-slack.ts`, extracted from the
inline one in `guardrails/no-explicit-any-ratchet.test.ts` so the four adopters share
one implementation and one place to prove that implementation is live. It reports
when `baseline - count > allowance`, and stays silent when `count > baseline` (that
is a real regression and belongs to the ratchet's own assertion, which can list the
offending sites).

## Files

| file | role |
| --- | --- |
| `tests/helpers/ratchet-slack.ts` | new — shared sentinel + the allowance-calibration rule |
| `tests/unit/ratchet-slack-sentinel.test.ts` | new — behavioural contract of the helper, plus the allowance cap over the four adopters |
| `tests/guardrails/raw-color-ratchet.test.ts` | 95 → 51; first sentinel; replaced a vacuous second test |
| `tests/guardrails/table-platform-drift.test.ts` | 15 → 11; first sentinel |
| `tests/guards/epic52-datatable-ratchet.test.ts` | 12 → 9; first sentinel |
| `tests/guards/border-tone-budget.test.ts` | 114 → 111; bespoke sentinel replaced by the shared one, allowance 10 → 2 |

## Decisions

- **An allowance must be strictly smaller than the drift it is introduced to
  correct.** This is the load-bearing decision, and it was found empirically rather
  than reasoned: the first draft picked `DRIFT_ALLOWANCE = 3` for epic52 against a
  drift of exactly 3, and kept border-tone's shipped `10` against a drift of 3.
  Replaying the pre-fix baselines through both showed them passing — sentinels tuned
  to sleep through a repeat of the failure that motivated them. Both are now 2, and
  all four fail on their own pre-fix baseline. The rule is written into the helper's
  header so the next adopter does not have to rediscover it.

- **`border-tone-budget` already had a sentinel and it still let 3 sites drift.**
  Its allowance (10) was wider than any drift it was likely to see, which made it
  structurally unable to report. Its old number is evidence, not precedent — hence
  the tightening rather than preservation. It is affordable there because that guard
  strips comments before counting, so a doc pass cannot move it.

- **The two `<table` ratchets count comment text.** The regexes are plain text scans,
  so a `<table` inside a comment counts like markup — 6 of 11 hits in
  `table-platform-drift`, 4 of 9 in epic52. That is why their allowances are not
  driven to 0 or 1: an unrelated doc pass would otherwise force an edit here. The
  live-hit lists mark each entry `markup` or `comment only` so the next reader is not
  misled into hunting for a table that does not exist.

- **The allowance is the only knob that can neuter a sentinel**, so it is capped.
  A baseline cannot be quietly raised (that widens slack, which is what the sentinel
  measures), leaving `DRIFT_ALLOWANCE` as the cheapest path back to green when a
  sentinel goes red — the same move that let these four decay. `MAX_ALLOWANCE = 5`
  in the sentinel test caps it, and the companion assertion checks each adopter still
  routes through the shared helper, because a deleted sentinel and a passing one look
  identical from the outside.

- **The two `<table>` guards legitimately disagree (11 vs 9).** They carry different
  exclusion sets: epic52 additionally excludes `admin/rbac/` (server component) and
  `reports/soa/SoAClient.tsx`. Both numbers were traced by hand rather than assumed
  equal.

- **Not addressed here:** `src/app/audit/shared/[token]/page.tsx` is now the entire
  raw-colour count (51 of 51). See the summary in the PR for the tokenise-vs-exempt
  recommendation; this diff deliberately only re-seats and does not move that surface.
