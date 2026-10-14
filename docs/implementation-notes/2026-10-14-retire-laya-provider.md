# 2026-10-14 — retiring the Laya provider (part 2 of 2)

**Commit:** `<sha> chore(ai): retire the Laya decision provider`

Part 1 removed the image and CI estate — see
`2026-10-14-retire-laya-image-estate.md`. This is the code half.

## Design

Asked how far to take the removal, the owner chose **Laya only — keep the Jev
code inert**. So this deletes the local provider and everything that configured
it, and leaves `JevDecisionProvider` and `TYPESAFE_SUBPROCESSOR_ACTIVE` exactly
where they are: the external branch stays in the source, unreachable while that
constant is `false`, which is what makes the withdrawal reversible by a reviewed
one-line diff rather than by rewriting a subsystem.

The consequence is worth stating in one line, because it is easy to read the
diff and miss it: **`getDecisionProvider` now returns the refusing stub on every
path.** `OFF` returns it, the `LOCAL_ONLY` residency guard returns it, the
sub-processor gate returns it, and the missing-credential arm returns it. The
identity-match decision model is structurally inert, and `LegacyMatchVerdict`
has held zero rows in production for its whole life, so nothing downstream
notices.

Identity matching itself is untouched: it runs on the deterministic engine
(Steps 3b and 4a), and the owner's ruling was to widen that layer instead.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/identity-match/laya-provider.ts` | deleted |
| `src/app-layer/ai/identity-match/index.ts` | import and `LAYA_TIMEOUT_MS` re-export dropped; `buildLocalProvider` returns the stub |
| `src/env.ts` | `LAYA_BASE_URL` / `LAYA_API_KEY` removed from the schema and the runtime map |
| `src/app-layer/usecases/tenant-security-settings.ts` | `LOCAL_ONLY` refused unconditionally; the now-dead `env` import removed |
| `scripts/eval-identity-match.ts` | `--provider laya` removed; `jev` is the only arm |
| `tests/guards/ai-residency-enforcement.test.ts` | pinned constructor set three → two |
| `tests/unit/identity-match-provider-factory.test.ts` | the provider-timeout tests and the concurrency-composition describe removed, with their measurements kept as prose |
| `tests/integration/legacy-adjudication-settings.test.ts` | the `LOCAL_ONLY` refusal re-pointed; the stored-mode test rewritten |
| `docs/legacy-access-recertification-{design,phases}.md` | status banners; three criteria amended |
| `docs/sub-processors.md` | the "local alternative" claim corrected |
| `CLAUDE.md` | the `LAYA_BASE_URL` rule rewritten as forward-looking |

## Decisions

- **The wire's Laya constants STAY, and this is the one that would have been a
  silent behaviour change.** `MAX_CHOICE_OPTIONS` is
  `Math.min(JEV_MAX_CHOICE_OPTIONS, LAYA_MAX_CHOICE_OPTIONS)` — 255 and 100 — so
  deleting the Laya bound would have **raised the cap the deterministic state
  builder enforces from 100 to 255**, with nothing in the diff looking like a
  cap change. `buildMatchState` refuses rather than trims, so that cap decides
  which accounts are reported `OVER_BUDGET`. The constants are inert data about
  a vendor's limits; they cost nothing to keep and keeping them changes nothing.

- **`LOCAL_ONLY` is refused unconditionally at the settings boundary**, where it
  used to be refused only when `LAYA_BASE_URL` was unset. A mode that cannot be
  served should fail where an admin reads the reason, not silently do nothing in
  a background job. The message names the measurement (#3490) and says what to
  set instead.

- **A migration case exists and is now tested.** Rows written before today can
  hold `legacyMatchAiMode = LOCAL_ONLY`, and they do not disappear when the
  model does. Such a tenant's next settings patch is refused — because the
  refusal reads the stored mode merged with the patch — until they set `OFF`,
  which is exactly what the message tells them. The test writes that row
  directly, since the usecase can no longer produce it.

- **That test was also asserting something it did not test.** Its name is "a
  stored mode is read as part of the combination, not just the patch" and its
  body supplied the mode *in the patch*, so the stored value played no part. The
  retirement is what exposed it: the assertion matched on `/LAYA_BASE_URL/`, and
  when that message changed the test failed for the wrong reason. It now writes
  the row first.

- **A whole `describe` was deleted and its measurements kept as prose.** The 6b
  concurrency-composition block related `LAYA_TIMEOUT_MS` to
  `REQUESTS_IN_FLIGHT`; the first is gone, the second is still read by
  `adjudication-pass.ts`. What it proved is the part worth keeping: two
  constants can each be defensible alone and broken together — #3448 set the
  timeout from the concurrency-1 figure while the configured concurrency was 4,
  where the measured p50 is 16,488 ms, so every call timed out.

- **The provider-factory test can no longer tell a correct factory from one that
  ignores its argument, and it now says so.** Its positive control has been
  rewritten twice by the same mechanism: first `isExternal === true` (removed by
  the withdrawal), then a discrimination control — `OFF` gives `stub`,
  `LOCAL_ONLY` gives `laya` — removed by this change, because every mode gives
  `stub`. Rather than delete the loop or pretend, the comment names what carries
  the evidence instead: `ai-residency-enforcement`, which reads the factory's
  SOURCE for the ordering and so survives every provider coinciding.

- **Three roadmap criteria moved, one of them to ticked.** The canary /
  evaluation-record criterion is now **moot by removal of its subject** — there
  is no deployed service to run a canary against — which is the same shape as
  the activation criterion below it. Said explicitly in the document, because
  "ticked" and "satisfied" are not the same thing and an auditor reading the
  list deserves to know which one it is. 173 of 177 ticked, 4 open: two are the
  owner's (legal review and the executed DPA; the notice window), one is #3508
  held for a coordinated quiet window, and one — "nothing in `src/` refers to
  TypeSafe" — stays open **by the owner's decision** to keep the Jev code.
