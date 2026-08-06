# 2026-08-06 — The last two source-regex guards become rendered tests

**Commit:** _(see branch `test/risk-rendered-and-unfreeze`)_

Third Box 3 tranche, finishing B3-4. The `rq` ceiling goes 37 → 36, and the
first extraction toward B3-5 lands with it.

## Design

Both remaining guards asserted things about files that only a browser can
actually answer. Both are now rendered.

### The ALE chip — extracted, then rendered

`rq3-4-tail-language` asserted the formatter's UI copy **verbatim, em-dash
included**:

```
expect(lib).toMatch(/\(mean — run a simulation for tails\)/)
expect(lib).toMatch(/bad year \$\{money\(aleP90\)\} \(P90\)/)
```

Copy-editing a string — or typing a hyphen where an em-dash was — turned CI
red, while nothing checked what a reader sees.

The chip was an inline IIFE inside a `RisksClient` column cell, so there was
nothing to render. It is now `_shared/RiskAleChip.tsx`, and
`tests/rendered/risk-ale-chip.test.tsx` asserts the **behaviour** the copy was
standing in for:

- tail data present → both registers;
- absent → the mean alone, never a fabricated bad year;
- **P90 equal to or below the mean is not tail data** — the subtle one. A
  simulation whose P90 lands on the mean would otherwise render
  "€100K · bad yr €100K", which reads as a measured tail rather than the
  absence of one;
- unquantified → **nothing at all**, not a zero and not a dash. A zero on a
  money column reads as "we measured this and it is nil"; the truth is
  "nobody has quantified it".

`rq3-4` survives, reduced to wiring: the list mounts `<RiskAleChip>` and feeds
it from the tail-percentiles cache. Wording is free to change now.

### The dashboard deep-links — rendered hrefs

`rq3-ob-c-tab-deep-links` sliced a **magic byte window** —
`dashboard.indexOf('risk-stale-row-') - 800` to `+ 400` — and regexed inside
it. An unrelated edit upstream slid the window off its target silently, and
the regexes pinned loop-variable names. #1797 replaced that with a count of
`?tab=assessment` occurrences: robust, but it could no longer say *which*
widget linked where, which is the only thing a user experiences.

`tests/rendered/risk-dashboard-deep-links.test.tsx` renders the dashboard and
reads the anchors. The invariant is **asymmetric on purpose**, and both halves
are asserted: the three rot widgets (coherence, staleness, overdue reviews)
deep-link into the assessment pane, because that is where the signal gets
closed; the top-10-by-ALE row deliberately does not, because it is a "show me
this" link rather than a "fix this" one. A blanket
"add `?tab=assessment` everywhere" change fails the last test.

The guard is deleted outright — every claim it made is now made by the
rendered test, more precisely.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/risks/_shared/RiskAleChip.tsx` | NEW — the chip, extracted from an inline IIFE |
| `src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx` | Mounts the component; drops the inline block and the formatter import |
| `tests/rendered/risk-ale-chip.test.tsx` | NEW — the two-register + honest-null contract |
| `tests/rendered/risk-dashboard-deep-links.test.tsx` | NEW — real hrefs for all three rot widgets, plus the deliberate non-deep-link |
| `tests/guards/rq3-4-tail-language.test.ts` | Reduced to wiring |
| `tests/guards/rq3-ob-c-tab-deep-links.test.ts` | DELETED |
| `tests/guards/no-epic-named-ratchets.test.ts` | Ceiling 37 → 36 |

## Decisions

- **Extraction was a prerequisite, not a bonus.** The chip could not be
  rendered while it was an IIFE inside a column cell, which is precisely why
  its only cover had been a regex over its enclosing file. This is the general
  shape of the RisksClient problem: the file is hard to test *because* it is
  monolithic, and it stays monolithic *because* the ratchets pinned to it make
  every extraction expensive. One component out is one loop broken.
- **`money` keeps the formatter's nullable signature.** The chip initially
  narrowed it to `(n: number) => string`, which typechecked in isolation and
  failed against `TailRegisterOptions`. Widening the prop rather than casting
  keeps the component honest about what it forwards.
- **The chip is in `_shared/`, not a new `_components/`.** That directory
  already exists beside it and holds exactly this kind of thing. B2-5 will
  decide whether the whole set moves to `components/risks/`; inventing a
  second convention now would just add work to that move.
- **`rq3-4` was reduced rather than deleted.** "The list mounts the chip and
  wires the tail cache" is still a real wiring claim, and no chip-level
  rendered test can make it. When `RisksClient` itself gets a render test in
  B3-5, this file goes.
