# 2026-08-07 — The dashboard heatmap ignored the tenant's matrix config

**Commit:** _(see branch `fix/risks-dashboard-heatmap-config`)_

Box 1's B1-5, which is also B2-3's "point `heatmapClassForBand` at
`resolveBandTone`" — one edit, done once.

## Design

Two independent defects in `risks/dashboard/page.tsx`, both producing a
heatmap that rendered cleanly and was wrong.

### (a) Toning by English band name

```ts
switch (band.name) {
    case 'Low':      return 'bg-bg-success …';
    case 'Medium':   return 'bg-bg-warning …';
    case 'High':     return 'bg-bg-warning/60 …';
    case 'Critical': return 'bg-bg-error …';
    default:         return 'bg-bg-muted/40 …';   // ← every custom tenant
}
```

Its own comment claimed the mapping "consults the tenant's CANONICAL band
(not a hard-coded score ladder), so a tenant who customises thresholds gets
the right tone without code changes." `RiskMatrixConfig` lets a tenant
**rename** bands — `RiskAssessmentPanel` reads `config.levelLabels` for
exactly that — so any tenant using anything but the four English defaults
fell through to `default:` and got a uniformly grey grid. The comment
described the intent; the code keyed on strings.

`resolveBandTone` keys off the band's **ordinal position** in the sorted set
— first is success, last is critical, the rest attention — so it is
rename-proof and works for any band count. It is the same resolver the
coverage table and the evaluation fields already use.

**Trade-off, taken deliberately:** with the default four bands the middle two
now share the attention tone, where 'High' previously had a distinct
`bg-bg-warning/60`. Losing one shade is a far smaller failure than a renamed
band greying the entire grid, and it makes the dashboard agree with the two
surfaces that already tone scores this way.

Not chosen: `RiskMatrixCell` renders the tenant's `band.color` hex directly
with luminance-based contrast (`readableTextOnHex`). That is arguably the
most faithful option, but it drops the semantic tokens that carry dark-mode
and the WCAG-AA guarantees, and two roadmap items independently specified
`resolveBandTone`.

### (b) A hardcoded 5×5 grid

`[5,4,3,2,1]` rows, `[1,2,3,4,5]` columns, `grid-cols-[auto_repeat(5,1fr)]`
— ignoring `config.likelihoodLevels` / `config.impactLevels`.

A 6×6 tenant got a **silently truncated** heatmap: the level-6 row and
column were never drawn, so every risk sitting there vanished from the
picture with nothing to indicate an omission. On a page whose purpose is
"where is my exposure concentrated?", the highest-severity corner is exactly
the part you cannot afford to lose. A 3×3 tenant got the opposite — phantom
cells for levels that do not exist.

Axes now derive from the config, with the 5 fallback kept only for the
loading window, matching the rest of the page's null-matrix handling.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/risks/dashboard/page.tsx` | `heatmapClassForScore` via `resolveBandTone`; config-driven axes |
| `tests/rendered/risk-dashboard-heatmap-config.test.tsx` | NEW — 6×6, 3×3, renamed bands, the previously-dropped level-6 cell |

## Decisions

- **Both halves are mutation-verified, separately.** Hardcoding the axes back
  to 5 fails 4 of the 5 tests; restoring the band-name switch fails the
  renamed-bands test. Neither was written to pass against code that already
  worked.
- **The test asserts a count of cells, not a snapshot.** A snapshot would
  have recorded the truncated 5×5 grid as correct — it renders without error
  and looks plausible. Counting `[data-band]` elements is what makes "36 not
  25" observable.
- **One test seeds a risk at likelihood 6 / impact 6** and asserts its count
  appears. That is the user-visible consequence of (b), not just a
  dimensional check: before, that risk existed in the data and nowhere in
  the picture.
- **`data-band` stays on every cell.** It backs the tooltip and gives the
  test a stable handle that does not depend on tone classes, which are
  exactly what this change alters.
