# 2026-07-22 — Two silent-decay classes: table-model identity, and dependency overrides

**Commit:** `<pending> fix(tables): stabilise row identities across every list client; add override-decay governance`

Two unrelated subsystems, one shared shape: a mechanism that *looks*
correct at every checkpoint while doing nothing. Both were surfaced by
the same question — "where else does this already exist?" — asked after
a fix that had been treated as complete.

## 1. DataTable row identity

### Design

`DataTable`'s interaction model (R13-PR14) gives single click to
selection and the row action to double-click:

```
selectionEnabled (default true)
  ├── onClick      → row.toggleSelected()      ← re-renders the row
  └── onDoubleClick→ onRowClick(row, e)
```

A real double-click therefore renders the row **between its two
clicks**. If the page hands `DataTable` a fresh `columns` /
`onRowClick` / `getRowId` identity on that render, the table model is
rebuilt, the row's DOM node is replaced, and the browser never fires
`dblclick` — the two clicks no longer share a live common ancestor.
Navigation dies silently. Nothing below the E2E layer sees it: tsc is
happy, the component renders, and no unit test performs a real two-click
gesture.

`#1678` fixed this for `PoliciesClient` and added
`datatable-stable-row-identity.test.ts` covering the two pages the E2E
asserts. A survey of the remaining list clients found **eleven more**
carrying the same shape — two of them (`TasksClient`, `VendorsClient`)
byte-for-byte identical to the original regression: a bare `tenantHref`
arrow sitting inside the column memo's dep array. They were invisible
only because no E2E exercised them.

### A third mechanism the guard did not model

`orderColumns` is a `useCallback`, so it *looks* stable — but its body
ends in `applySlotOrder`, which returns `[...columns]`. It mints a new
array on every call. So:

```tsx
columns={orderColumns(assetColumns)}   // fresh identity every render
```

undoes a perfectly correct inner `useMemo`, and the instability is
introduced at the **call site** — invisible to any dep-array analysis.
Four files did this, including `ControlsClient`, the reference
implementation for the entity-page architecture and one of only two
files the original guard covered. It had `getRowId` and `onRowClick`
right and missed `onRowPrefetch` and this. A partial fix that reads as
a complete one.

### Two guards were pinning the anti-pattern

`item-27-32-34-asset-ux.test.ts` and `tasks-quickview-interaction.test.ts`
both asserted double-click navigation by matching the handler body
*inline in the JSX prop*:

```ts
expect(src).toMatch(/onRowClick=\{\(row\) =>\s*router\.push\(tenantHref\(`\/assets\/…/);
```

Correct intent, wrong encoding: it made the identity-unstable form a
**requirement**. Both now assert the behaviour (row action navigates to
the detail route) against a named, `useCallback`-wrapped handler.

## 2. Dependency-override decay

### Design

`overrides` forces a patched transitive dependency when an advisory
lands against a version pulled in by a package we don't control. It has
two silent-decay modes, and the repo was carrying both:

**Raising a floor does not move the lockfile.** `hono` was pinned
`^4.12.23`; the range admitted the patched 4.12.31; the lockfile sat on
vulnerable 4.12.25 until the audit gate went red weeks later.

**An override can rewrite nothing.** The only `tar` in the tree lives
in npm's *bundled* dependency tree, which npm ships prebuilt and no
override can reach. What keeps that copy safe is the `npm` pin — the
`tar` entry is inert.

Neither is detectable from the same vantage point, so the coverage is
split:

| | `tests/guards/overrides-effective.test.ts` | `.github/workflows/override-freshness.yml` |
|---|---|---|
| When | every CI run | weekly + manual |
| Network | no | yes (npm registry) |
| Catches | unregistered override · floor lowered below the recorded fix · override that rewrites nothing · stale inert note | newer version *inside* the range that the lockfile hasn't picked up · newest release *outside* the range |

A Jest guard must not make network calls, and the registry is the only
place "is there a newer fix?" lives — hence two artefacts rather than
one.

### Findings on first run

The offline guard failed immediately on `tar` (inert). The freshness
script reported **six** overrides lagging a version their own range
already permits — the hono shape, live. None are currently flagged by
`npm audit`, so they are drift rather than exposure; the lockfile
refresh is deliberately left out of this change so the governance
mechanism lands without a large dependency churn beside it.

## Files

| File | Role |
| --- | --- |
| `tests/guards/datatable-stable-row-identity.test.ts` | 2 → 13 clients; both prop syntaxes; new `orderColumns` call-site rule |
| 12 list clients + `ControlsClient` | `useTenantHref`, `useCallback` handlers, memoised `orderColumns` result |
| `tests/guards/item-27-32-34-asset-ux.test.ts` · `tasks-quickview-interaction.test.ts` | assert behaviour, not the inline shape |
| `tests/guards/overrides-effective.test.ts` | **new** — registry + effectiveness + inert declaration |
| `scripts/check-override-freshness.mjs` | **new** — registry comparison, `--json` / `--strict` |
| `.github/workflows/override-freshness.yml` | **new** — weekly, non-blocking, one tracking issue |
| `docs/dependency-policy.md` | decay section; Node 22 → 24 correction |

## Decisions

- **Listed the full population of list clients, not the E2E-covered
  subset.** The original guard covered exactly the two pages an E2E
  asserted, which made "has a test" and "is protected" different
  things — and eleven pages lived in the gap. A guard scoped to what
  already has coverage inherits that coverage's blind spots.

- **Kept the inert `tar` override, declared rather than deleted.**
  Deleting it is defensible (it protects nothing) but loses a floor if
  `tar` re-enters the real tree, and I'd be acting on an inference
  about why it was added in #1252. Marking it `currentlyInert` with a
  written reason makes the dead state *reviewed* instead of silent, and
  the check is bidirectional — if `tar` starts biting, the stale note
  fails CI and forces a fresh look. A silent deletion trades a visible
  problem for an invisible one.

- **Recorded `patchedFrom` per security override.** This is the fact
  whose absence let `hono` rot: with the version the fix landed in
  written down, "is our floor still the patch?" is answerable from the
  repo, and the freshness job has something to compare against.

- **Freshness is non-blocking.** `npm audit` blocks on evidence of a
  real advisory; this job reasons about version arithmetic, which is a
  weaker signal. Making it blocking would fail CI for routine
  upstream releases. It maintains ONE tracking issue rather than
  opening a weekly duplicate — a cron that stacks issues trains people
  to ignore it.

- **Hand-rolled the semver comparator.** `semver` is not a declared
  dependency and guards here stay dependency-free. The risk is a
  comparator bug making every assertion vacuously true, so the guard
  pins its own comparator's behaviour — including that it *throws* on
  range shapes it does not understand rather than defaulting to
  "satisfied".
