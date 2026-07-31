# 2026-07-31 — KPI value legibility + list-filter enum 500s

**Commit:** `<pending> fix(dashboard,repositories): make the KPI value legible and stop unvalidated enum filters 500ing`

Two unrelated production reports, bundled because both were one-line
defects with a shared shape: a value crossing a boundary unchecked.

## Design

### A — the CONTROLS KPI rendered `. %`

Reported symptom: the dashboard's CONTROLS tile showed bare punctuation
where `11.2%` belonged, with a correct subtitle ("14 of 125
implemented"). The obvious hypothesis was a `NaN` reaching the
formatter. It was not.

Three links in the chain were verified against the live system before
anything was changed:

| Link | Evidence | Verdict |
| --- | --- | --- |
| The data | `SELECT status, count(*) … GROUP BY` on the production database: 92 NOT_STARTED + 4 IN_PROGRESS + 14 IMPLEMENTED + 15 NEEDS_REVIEW = 125 applicable | correct |
| The derivation | the deployed server bundle's `getControlCoverage` is byte-identical to `main` (`m=f>0?Math.round(g/f*1e3)/10:0` → 11.2) | correct |
| The render | reproduced in a real Chrome via Playwright | **broken** |

The render is the bug. `KpiCard` paints the headline value by clipping a
gradient to the text:

```tsx
<span className="bg-gradient-to-r … bg-clip-text text-transparent">
    <AnimatedNumber value={value} format={animatedFormat} />
</span>
```

`<AnimatedNumber>`'s animated branch mounts `@number-flow/react`, which
renders the `<number-flow>` **custom element**. Its shadow root sets
`isolation: isolate` on `:host`, and its symbol spans carry
`mix-blend-mode: plus-lighter` — both make the subtree its own paint
group. An ancestor's text-clipped background is never painted into an
isolated group, so the glyphs keep the `text-transparent` colour they
inherited.

The reproduction, using the production CSS file pulled out of the running
container and the exact KpiCard markup, is unambiguous:

```
plain text  in bg-clip-text wrapper → "11.2%" in emerald gradient   ✓
number-flow in bg-clip-text wrapper → nothing at all                ✗
number-flow with a solid colour     → "11.2%"                       ✓
```

Chrome paints none of it. An engine that paints the un-clipped
punctuation but not the transformed digit stacks paints only the
separators — the reported `. %`. Either way the number was unreadable,
on **every** KpiCard in the product, not just this tile.

The fix is `animate={false}` on the clipped value: the static branch is
ordinary text in an ordinary `<span>`, which `bg-clip-text` clips
correctly. Nothing observable is lost — an animation of invisible digits
was never observable. The trend-indicator `<AnimatedNumber>` sits under a
solid token colour and keeps animating.

Separately, and as the second half of the report, non-finite values are
now "no data" everywhere rather than formatter leftovers: `AnimatedNumber`
renders `—` for `NaN`/`±Infinity` instead of `NaN%`, `KpiCard` and
`HeroMetric` fold non-finite into their existing empty branch, and
`getControlCoverage` returns a percentage guaranteed finite and clamped
to [0, 100].

### B — `?status=ACTIVE` → 500 → "Something went wrong"

Reported symptom: `GET /api/t/{slug}/…ks?status=ACTIVE` 500ing, plus a
Server Components render error and broken assets / risks / controls
pages.

The route is `/risks`. `RiskRepository._buildWhere` did

```ts
if (filters.status) where.status = filters.status as RiskStatus;
```

— the structural twin of the Controls bug fixed in #1742. Reproduced
directly against the generated client:

```
risks?status=ACTIVE          → PrismaClientValidationError
risks?status=OPEN,MITIGATING → PrismaClientValidationError
risks?status=OPEN            → passes validation (fails only on connect)
```

Both bad shapes are reachable from the UI. Every list facet is
`multiple: true` and `toApiSearchParams` comma-joins, so selecting two
statuses sends the literal `"OPEN,MITIGATING"`. And `status` is a shared
URL key across list pages, so a link carried over from Assets or Vendors
arrives at `/risks` carrying `ACTIVE` — an `AssetStatus`, never a
`RiskStatus`.

`PrismaClientValidationError` has no branch in `src/lib/errors/types.ts`,
so it defaults to **500**. `risks/page.tsx` reads the same filters inside
the Server Component, so the failure was not a contained fetch error — it
took the render down.

Two independently-grown copies of the correct parser already existed
(`WorkItemRepository.parseListFilter`, `ControlRepository._parseStatusFilter`).
Both now delegate to one shared `src/app-layer/domain/list-filter.ts`, and
every remaining `as`-cast filter in `src/app-layer/repositories` routes
through it. Unknown members are a 400 with the allowed list named, not a
500.

### C — `useTenantSWR` double-prefixing

`useTenantSWR(path)` resolves through `useTenantApiUrl()`, which prepends
`/api/t/{slug}`. Two call sites passed an already-absolute path, building
`/api/t/{slug}/api/t/{slug}/…` → 404 (×4, SWR's retry count).

The failure is silent by construction: `data` stays `undefined`, so a
component defaulting with `?? 0` / `?? []` renders plausible zeros. The
vendors list KPI cards read 0 for every vendor; the access-review
directory-availability gate never applied at all, so that feature had
shipped inert.

`useTenantApiUrl` deliberately does NOT strip an existing prefix —
silently repairing the argument hides the mistake from the next reader.
A ratchet catches it instead.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/animated-number.tsx` | Non-finite → `—` placeholder in both branches; documents why the animated branch cannot live under a clipped gradient |
| `src/components/ui/KpiCard.tsx` | Value slot renders the static branch; non-finite folds into the empty branch |
| `src/components/ui/HeroMetric.tsx` | Same non-finite handling for the 72px masthead |
| `src/app-layer/repositories/DashboardRepository.ts` | `finitePercent` makes the `coveragePercent` contract total |
| `src/app-layer/domain/list-filter.ts` | **New.** The one canonical `parseEnumListFilter` / `parseIdListFilter` |
| `src/app-layer/repositories/{Risk,Asset,Vendor,Policy,Evidence,AiSystem}Repository.ts` | Enum filters validated instead of cast |
| `src/app-layer/repositories/{WorkItem,Control}Repository.ts` | The two prior copies now delegate to the shared parser |
| `src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx` | Tenant-relative SWR path (KPI cards were reading 0) |
| `src/app/t/[tenantSlug]/(app)/access-reviews/AccessReviewsClient.tsx` | Tenant-relative SWR path (directory gate was inert) |

## Decisions

- **Kept the gradient, dropped the animation — not the reverse.** The
  gradient is the design and is what users see; the roll animation was
  strictly invisible under it. Solving it the other way (solid colour,
  keep animating) would have traded a visible feature for an invisible
  one. `HeroMetric` already uses a solid colour, which is exactly why the
  masthead was never affected.
- **Did not "fix" the derivation, because it was not broken.** The prompt
  suspected `NaN`; the production database and the deployed bundle both
  say 11.2. `finitePercent` is still worth adding — it turns a
  situational guard (`applicable > 0`) into a total one — but it is
  hardening, not the fix, and the note says so rather than claiming a
  cause that was not there.
- **Invalid filter → 400, not silently-empty.** Matching zero rows reads
  to the user as "you have no risks". Naming the bad value and the
  allowed set lets a stale bookmark be diagnosed from the response.
- **One parser, not a third copy.** Three independent implementations of
  the same 15 lines is how the bug came back after #1742.
- **Scoped to `src/app-layer/repositories`.** Four usecase-level sites
  (`due-planning`, `agent-proposals`, `framework-delta`, `workflow-runs`)
  carry the same `as never` shape and are follow-up work — the ratchet
  covers the repository layer, where every list page's filters land.
