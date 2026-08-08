# 2026-08-08 — Controls surface: structural remediation (roadmap P3)

**Commit:** `4f53ccc0 refactor(controls): move the whole domain into usecases/control, retire the page hacks (P3.3, P3.7, P3.2)` (and `5a21806d`, `5b48ce38`)

The third of three prompts on the Controls surface. P1 fixed seven
correctness defects; P2 collapsed the write-contract duplication; P3 —
this one — addressed the structural findings, ordered by future change
cost. The prompt's standing instruction shaped several of these: *where a
change is blocked by a ratchet, edit the ratchet in the same diff and say
why — do not leave the ratchet as the reason not to fix the architecture.*
That happened four times, and in three of them the ratchet was the only
thing keeping the problem alive.

## Design

### The domain had two homes (P3.3)

`src/app-layer/usecases/control/` held 1,922 lines across 8 files. A
further 1,801 lines of the same domain sat *next to* it as flat siblings:

```
usecases/
  control-test.ts       1125    ─┐
  control-exception.ts   454     ├─ 49% of the Control domain,
  control-roi.ts         222    ─┘  outside the directory named after it
  control/
    mutations.ts  queries.ts  templates.ts  health.ts
    evidence.ts   page-data.ts  template-projection.ts  index.ts
```

So `control/index.ts` looked like the domain's import surface and was
not: 45 call sites reached past it to the flat files. All three moved in
(`test-plans.ts`, `exceptions.ts`, `roi.ts`) and every call site now
imports the barrel.

Three more moves in the same shape:

- **`templates.ts` → `mappings.ts`.** Two of its seven exports are about
  templates; the other five are framework/requirement mapping. The name
  sent people looking for mapping code into the wrong file.
- **`evidence.ts` split** into `evidence.ts` / `asset-links.ts` /
  `contributors.ts` — three unrelated relationship graphs behind one
  filename, so "where does a new link type go?" had no answer you could
  read off the directory.
- **`getControlDashboard` + `runConsistencyCheck` → `dashboard.ts`.**
  `queries.ts` was answering two different questions: per-request
  list/detail reads (paginated, tenant-scoped) and whole-tenant admin
  scans bounded by `FULL_SCAN_CAP`. Only the second kind is
  replica-routed, which is why the routing guard's entry moved with them.

### The filter fork, resolved in opposite directions (P3.4)

The Controls list had two facets the server could not serve, and the page
compensated by stripping them from its API query and re-filtering the
loaded rows in the browser. Both halves are now decided, and they went
opposite ways.

**`applicability` moved server-side.** The column shows three states over
a two-value enum:

| display state | `applicability` | `applicabilityDecidedAt` |
| --- | --- | --- |
| N/A | `NOT_APPLICABLE` | (ignored) |
| Yes | not N/A | set |
| Not assessed | not N/A | null |

That *is* expressible in SQL, so `@/lib/controls/control-applicability`
now owns both halves — `applicabilityState` (what a cell shows) and
`applicabilityStateWhere` (what selects those rows) — and
`tests/unit/control-applicability-states.test.ts` runs them over one row
matrix so they cannot drift. Two things got better beyond tidiness: the
facet now sees every control rather than the loaded page, and
multi-select works (the route's `z.enum()` used to 400 on the
comma-joined value the picker actually sends, which is part of why the
client stripped the param).

**`category` stayed client-side and stopped pretending otherwise.** The
column shows a *derived* value — `categorizeControl` parses an ISO Annex
clause out of `annexId`/`code` with a permissive regex and looks it up in
a 93-entry map, falling back to a framework code prefix, then the stored
string. Pushing that into SQL means either duplicating the parser in the
query builder (a second source of truth for the thing that function *is*)
or persisting the derived value with a backfill. Neither is worth it
while the page cap doesn't bind; the second is the named path if it ever
does.

What *was* wrong is that the SSR read still passed `category` through
from the URL, matching the raw stored column against a value the user
picked from the derived set — so the same URL returned ~0 rows on a hard
nav and filtered correctly after a client nav. The raw filter is gone
from the repository, the usecase and the route schema, and
`Control_tenantId_category_idx` is dropped: it had no correct producer.

### The autosave engine was frozen by its own test (P3.5)

`ControlEditPanel` and `TaskEditPanel` each carried the same ~65-line
machine — `fieldsRef`, `saveTimer`, `commitFields`, `scheduleCommit`,
`commitNow`, `update(partial, immediate)`, the four-state status — with

```ts
saveTimer.current = setTimeout(() => void commitFields(), 800);
```

byte-identical in both. The only thing verifying any of it was that regex,
asserted against **each file separately**. So extracting the shared hook
broke both assertions: the ratchet required the duplication to exist. It
also verified nothing about behaviour — it would have passed on a
debounce that never fired, one that read a stale closure, or one that
leaked a timer past unmount.

`useAutosaveFields` replaces both copies. The two frozen assertions became
23 behavioural ones covering what the regex was standing in for:
coalescing a keystroke burst into one save carrying the *last* value,
`commitNow` cancelling the pending timer, no save after unmount, the
status machine, `validate` running *before* the status moves to `saving`,
and `canCommit` being read fresh at commit time.

The hook owns the values, which made the panels controlled — and that
removed the *reason* the caller had to remount them with
``key={`qv-control-${id}`}``. The key stays for `AsidePanel`'s
`openOnMount` (a genuine mount-only effect), and the comments now say
only that.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/hooks/use-autosave-fields.ts` | the shared debounced-autosave engine (new) |
| `src/lib/controls/control-applicability.ts` | three-state display derivation + its SQL twin (new) |
| `src/app/t/[tenantSlug]/(app)/controls/_lib/bulk-action-policy.ts` | which bulk verbs each role may use (new) |
| `src/app-layer/usecases/control/{test-plans,exceptions,roi}.ts` | moved in from flat siblings |
| `src/app-layer/usecases/control/{asset-links,contributors,dashboard}.ts` | split out of `evidence.ts` / `queries.ts` |
| `src/app-layer/usecases/control/mappings.ts` | renamed from `templates.ts` |
| `src/app-layer/repositories/ControlRepository.ts` | three-state applicability predicate; raw `category` filter removed |
| `prisma/migrations/20260808120000_drop_control_category_index/` | drops the index with no correct producer |
| `src/components/ui/table/{data-table,table,types}.tsx` | `renderExpandedRow` removed |
| `src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx` | file-wide lint disable removed; bulk actions via the policy + `useTenantMutation` |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/page.tsx` | Activity tab now uses `PanelActivityFeed` |
| `tests/guards/controls-quickview-interaction.test.ts` | the two frozen regexes replaced with a delegation check |
| `tests/guards/controls-row-expansion.test.ts` | narrowed to wiring; primitive internals moved to the rendered test |

## Decisions

- **Two identical mechanisms, one used → delete the unused one.**
  `DataTable` carried both `renderExpandedRow` (one full-width colSpan
  cell) and `renderAlignedSubRows` (real `<tr>`/`<td>` rows that line up
  with the columns). The second exists *because* a colSpan cell cannot
  align, and the first had no consumer anywhere in the product — kept
  alive by a Controls ratchet that regexed `table.tsx` for it. The
  rendered test was rewritten against the surviving slot rather than
  deleted with the prop.

- **`OptimisticUpdater` returns `TData | undefined` now.** It used to
  return `TData`, with no way to say "no prediction for this state". Both
  callers had to invent a value on a cold cache: the control detail page
  wrote `current as unknown as ControlPageDataDTO` (a double cast that
  types `undefined` as a full DTO — every field read off it would throw
  if it ever ran), and `FindingsClient` synthesised an empty list whose
  only stated job was satisfying the non-optional return type. Painting
  "you have no findings" is worse than painting nothing.

- **A blanket lint disable is worth removing even when the findings are
  small.** ControlsClient's file-wide `react-hooks/exhaustive-deps`
  disable was hiding exactly six findings — one of them a `rawControls`
  array literal rebuilt every render that two memos depended on, which
  rebuilt the table model on every render. Six inline fixes, zero
  warnings, no suppression.

- **The bulk-delete undo flow did NOT move to `useTenantMutation`.** The
  hook applies optimism and fires the request immediately; the Epic 67
  undo pattern deliberately *delays* the request past the toast window.
  Bulk status/assign did move — that one was POST-then-full-refetch, so
  the table sat on stale values for a round trip.

- **Two claims in the brief did not survive measurement.**
  `EntityListPage.aside` was listed as a Controls-only prop; four
  surfaces use the underlying `ListPageShell.Body aside`, and removing it
  would evict Controls from the shell rather than simplify the primitive.
  `getRowCanExpand` is TanStack's own API name, not a Controls concept —
  it stays, and with `renderExpandedRow` gone there is now exactly one
  expansion mechanism instead of two.

- **The 250 ms selection settle stays.** It compensates for `DataTable`'s
  click model (single click toggles selection, double click navigates),
  where gating the bulk bar on the live selection flashes it mid
  double-click and the reflow breaks double-click-to-open. The structural
  fix belongs in the primitive's click model and would touch seven pages;
  the compensation is documented, measured, and cheaper than the cure.

- **`i18n-adoption-ratchet` now skips `__tests__`.** Epic 67 established
  co-located hook tests under `src/**/__tests__/`, and the first such
  file to render JSX tripped a guard that walks `src/**/*.tsx` looking for
  un-localised UI. A test harness rendering `<input aria-label="name" />`
  is not a user-facing surface; localising it would mean translating
  fixtures.
