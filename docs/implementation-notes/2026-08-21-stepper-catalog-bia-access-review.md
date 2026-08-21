# 2026-08-21 — stepper catalog: `bia` + `accessReview`, and the floor reconciliation

**Commit:** `(this branch) feat(i18n): stepper phrases for BIAs and access reviews, and reconcile the rendered floor`

## Design

Central reconciliation after the six-task wave (#97, #98, #99, #119, #120, #123).
Three things that could only be done once, after the lanes landed, because each is
a single shared line that three concurrent writers would have collided on.

### 1. The two missing catalog slugs

`#99` wired `audits/business-continuity/[id]` and `access-reviews/[reviewId]`,
passing `labelSingular: 'bia'` and `'accessReview'`. Neither was in
`ui.recordStepper`, so both rendered the generic *Previous / Next item* — visible
in the rendered DOM as `aria-label="previous.item"`. Cosmetic, never broken, and
the lane flagged it rather than reaching into a banned file.

Nouns are taken from the catalog rather than invented, as the earlier four were:

| slug | en | bg | source | gender |
|---|---|---|---|---|
| `bia` | Previous / Next BIA | Предишен / Следващ **анализ** | `audits.bia.resourceAnalysis` = *анализ* | m |
| `accessReview` | Previous / Next access review | Предишен / Следващ **преглед на достъпа** | `calendar.eventType.access-review-due` | m |

`анализ` is the product's own singular for a BIA record — the register empty state
is *"Няма съвпадащи анализи"*. Using it keeps the stepper speaking the same
Bulgarian as the screen behind it.

### 2. The gender table covered seven of thirteen

`entity-prev-next-nav.test.tsx` asserts rendered Bulgarian per entity. It still
held only the original seven from #108 — so the four slugs added for the audits
and frameworks wave went in **unasserted**, including the one interesting case:

    m  -ен / -ащ    актив, контрол, инцидент, риск, доставчик, цикъл,
                    пакет, преглед, анализ
    f  -на / -аща   политика, задача, рамка
    n  -но / -ащо   изпълнение          ← only one, and the easiest to miss

`изпълнение` (test run) is **neuter** — a third agreement form beyond the
masculine/feminine split #108 was written around. It was correct in the catalog
and nothing rendered it in a test. The table now covers all thirteen.

Mutation-proved: writing the neuter as masculine (*Предишен изпълнение*) fails 1
of 29; leaving `bia` as the generic fallback fails 1 of 29.

### 3. `RENDERED_TEST_FLOOR` 238 → 246

The wave added six rendered suites, landing live=246 against floor=238 — exactly
`SLACK.rendered`, i.e. **zero headroom**. The guard passes there, so nothing was
red; the next person to add any rendered test would have gone red for a reason
unrelated to their work. Raised as its own change, after the merges, because
raising it *before* would have failed the opposite assertion (`count >= floor`).

## The surface is not finished, and the record should say so

`#99` reads as the end of the stepper work. It is not. Three detail routes have a
real list of siblings behind them and still have no stepper:

| route | list behind it |
|---|---|
| `issues/[issueId]` | `issues/page.tsx` |
| `risks/ai-systems/[systemId]` | `risks/ai-systems/page.tsx` |
| `tests/plans/[planId]` (and `controls/[controlId]/tests/[planId]`) | `tests/page.tsx` |

None was considered and rejected — they were not reached. The structural reason is
the same for all three: **they do not use `EntityDetailLayout`**, so there is no
`prevNext` prop to pass, and the sweep that found the wave's candidates keyed on
that shell. That is a different thing from #99's declines, which were judgements
about whether stepping *makes sense* (a questionnaire reached from a notification,
a review queue holding unsaved edits).

`issues/[issueId]` was named by neither the lane nor its verifier; it surfaced only
on a re-sweep that dropped the `EntityDetailLayout` filter.

#99's own note is left untouched — `docs/implementation-notes/**` is a historical
record by path, and correcting it in place would erase what was actually known at
the time. The correction belongs here, where the trail leads.

## Files

| file | role |
|---|---|
| `messages/en.json`, `messages/bg.json` | the two phrase pairs, per direction |
| `src/components/ui/entity-prev-next-nav.tsx` | `STEPPER_ENTITIES` registration |
| `tests/rendered/entity-prev-next-nav.test.tsx` | gender table 7 → 13 rows |
| `tests/guards/rendered-coverage-floor.test.ts` | floor 238 → 246 with the dated reason |

## Decisions

- **Catalog centrally, not per lane.** Three lanes each needed these two files and
  the same line of `STEPPER_ENTITIES`. Landing the vocabulary first (#2062) and the
  remainder here turned a guaranteed three-way conflict into lanes that touch only
  their own page. The cost is two extra PRs; the alternative is three rebases.
- **A slug is registered only with both locales present.** The catalog-agreement
  tests fail on a slug with no `bg` phrase, so "register it now, translate later"
  is not reachable — which is deliberate, because the failure mode of a missing
  translation is silent fallback to *item* for exactly the readers it matters to.
