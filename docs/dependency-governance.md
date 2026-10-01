# Dependency governance

The single entry point for how this repo manages its dependency
graph. It ties together the install-time policy
(`dependency-policy.md`), the periodic risk review
(`dependency-risk-review.md`), and the structural guardrails that
enforce both — and states the contributor workflow for changing a
dependency.

The goal is a dependency posture that is **explicit, deterministic,
secure, and resistant to silent drift**. Every rule below is backed
by a CI guardrail, so the safe path is the default path and a
regression fails at PR time rather than being discovered in
production.

## The four governance pillars

| Pillar | What it guarantees | Enforced by |
|--------|--------------------|-------------|
| **Deterministic installs** | Every install path runs `npm ci` against a locked tree, on a pinned Node major. Two runs of one commit produce an identical `node_modules`. | `tests/guards/deterministic-install.test.ts` |
| **Strict peer resolution** | No `--legacy-peer-deps` anywhere. npm validates the peer graph on every install; an incompatible package fails fast. Accepted mismatches are named individually in the `overrides` block. | `tests/guards/no-legacy-peer-deps.test.ts` |
| **Framework version coherence** | `next` owns its own `@next/swc-*` platform binaries — the consumer never pins them. Every `@next/swc-*` lockfile entry tracks the resolved `next` version, so all platforms build with matching SWC. | `tests/guards/swc-version-coherence.test.ts` |
| **Reviewed runtime risk** | Dependencies with CVE-active history or a large blast radius are reviewed package-by-package; the review verdict (section + major floor) is locked. | `tests/guards/dependency-risk-review.test.ts` |

A fifth, narrower lock — the **auth-stack pin** — keeps `next-auth`
on its reviewed major (see the NextAuth policy below):
`tests/guardrails/auth-stack-pinning.test.ts`.

All five are themselves guarded by the meta-ratchet
`tests/guards/dependency-governance-integrity.test.ts` — a
contributor who deletes or guts any one of them meets a red
"guard the guards" test.

## The dependency lifecycle — contributor workflow

### Adding a dependency

1. **Justify the runtime role.** Does it ship in the production
   image, or is it build/test only? That answer decides the
   `package.json` section — `dependencies` vs `devDependencies`. Get
   it right the first time: the `Dockerfile` runs
   `npm prune --omit=dev`, so a runtime package wrongly in
   `devDependencies` is stripped from the image and crashes in
   production where CI cannot see it.
2. **Install with `npm install <pkg>` locally**, then commit the
   `package-lock.json` change. CI runs `npm ci` — it will reject a
   lockfile that drifts from `package.json`.
3. **Strict peers must pass.** If the install reports a peer
   conflict, do **not** reach for `--legacy-peer-deps`. Either pick
   a compatible version, or — if the mismatch is genuinely safe —
   add a *granular* `overrides` entry and document why in
   `dependency-policy.md`.
4. **If the package parses untrusted input, handles credentials, or
   has a CVE-active ecosystem**, review it: add a section to
   `dependency-risk-review.md` and an entry to the `REVIEWED` map in
   `dependency-risk-review.test.ts`, in the same PR.

### Upgrading a dependency

- **In-major bumps** (patch/minor) are free — the caret range
  already allows them and `npm ci` locks the exact resolved
  version.
- **Major bumps** are a deliberate review. Read the changelog for
  breaking changes, run the affected test suites, and update any
  guardrail that pins the old major (`dependency-risk-review.test.ts`
  for a reviewed package, `auth-stack-pinning.test.ts` for
  `next-auth`) in the same PR.
- **Never** run `npm audit fix --force` — it resolves advisories by
  downgrading or cross-grading packages with no regard for the
  codebase. Fix a transitive CVE with a targeted `overrides` entry
  instead (see "Security overrides" in `dependency-policy.md`).

### Removing a dependency

- Confirm zero import sites with an exhaustive grep across `src/**`,
  `next.config.js`, `src/instrumentation.ts`, and dynamic
  `import()` / `require()` before deleting it.
- A risk review **never** removes a package — reclassification and
  removal are separate, deliberate changes.

## The `overrides` block — two kinds, one rule

`package.json` carries an `overrides` block. Every entry is one of
two kinds, and both are documented in `dependency-policy.md`:

- **Bridge override** — a peer range that has not yet caught up to a <!-- docs-accuracy-allow: present-tense description of an override category, not a future-work marker -->
  version we run (e.g. `@visx/*` peering `react ^18` while we run
  `react@19`). A bridge is temporary: drop it when upstream ships a
  release whose peer range genuinely includes our version.
- **Security override** — forces a *patched* transitive dependency
  when an advisory lands against a version pulled in by a package we
  don't control (e.g. `uuid → ^11.1.1`). A security override is
  **not** a convenience bridge — keep it until the upstream package
  itself depends on a patched range.

The rule that unites them: an override names *exactly* which
mismatch is accepted and why. It is the precise opposite of the
blanket `--legacy-peer-deps` — every *other* package's peers stay
strictly validated.

## NextAuth — stay on v4 until 5.0.0 GA

`next-auth` is pinned to **`4.24.14`** (exact, no caret) and the
v4-era `@next-auth/prisma-adapter`. This is a deliberate, reviewed
decision, not lag:

- **NextAuth v5 has no stable release.** As of 2026-05-22 the v5
  line is beta-only (`5.0.0-beta.x`); npm's `latest` dist-tag still
  points at `4.24.14`. v4 is the supported stable line.
- **The audit's GAP-04** found the production auth layer briefly
  running on `next-auth@5.0.0-beta.30`, whose type drift forced
  `as any` casts into the auth-critical path. Commit `4de1988`
  migrated back to v4 stable and removed those casts.
- `auth-stack-pinning.test.ts` locks the post-migration state:
  `next-auth` must be an exact `4.x.x` (no caret, no `beta` / `rc` /
  `canary` suffix), the adapter must be `@next-auth/prisma-adapter`
  (not the v5 `@auth/prisma-adapter`), and the v5-only
  `auth.config.ts` must not return.

**Recheck cadence:** when `next-auth`'s `latest` dist-tag advances to
a real `5.x.x` GA, schedule the migration as its own project —
update `auth-stack-pinning.test.ts` and this section in the same PR.
Until then, a slip back to a beta build fails CI. The v4 pin is
correct; the guardrail keeps it from eroding by accident.

## react-window — on v2 since the upstream table sync

`react-window` is `^2.3.3`. `@types/react-window` and
`react-virtualized-auto-sizer` are **gone**, removed by the same
change.

This section used to read "stay on v1 until something forces v2", and
the reversal is deliberate rather than a dependabot merge. What forced
it is the last of the conditions the old section itself listed:

> either wrapper needs substantial work anyway, which makes the
> rewrite marginal rather than additional.

Both wrappers did. The downstream product that vendors these files
(playerz) ported them to v2 and made `<DataTable>` safe on phones in
the same work, and this repo is the upstream of that pair — so the
alternative was not "stay on v1", it was "keep two divergent copies of
the table platform". Issue #3003 (task T04) is the sync; dependabot
#2981, which proposed the version bump with no port behind it, is
superseded by it and closed.

### What v2 changed, name by name

v2 is an API rewrite, not a version bump. Every v1 export this repo
imported is gone; it exports a single `List` (plus `Grid`) instead:

| v1, as used here | v2 equivalent |
|---|---|
| `FixedSizeList` + `VariableSizeList` | one `List`, with `rowHeight: number \| string \| (index) => number \| DynamicRowHeight` |
| `ListChildComponentProps` | `RowComponentProps` |
| children-as-component | `rowComponent` prop |
| `itemCount` / `itemSize` / `itemData` | `rowCount` / `rowHeight` / `rowProps` (`rowProps` is REQUIRED) |
| `onItemsRendered({ visibleStopIndex, … })` | `onRowsRendered({ startIndex, stopIndex }, allRows)` |
| ref `.scrollToItem(index, align)` | `listRef.scrollToRow({ index, align, behavior })`, which THROWS a `RangeError` on an out-of-range index instead of clamping |
| ref `.scrollTo(offset)` | no equivalent — the handle exposes `element`, which IS the scroller |
| `VariableSizeList.resetAfterIndex(i)` | no equivalent — sizes are re-derived when `rowProps` identity changes |
| `outerElementType` / `innerElementType` | **no equivalent** — v2 has `tagName` (a tag NAME, not a component) plus `children` rendered as an overlay above the rows |

That last row was the load-bearing one, and it is the one that cost
design work. `virtual-table-body.tsx` passed a memoised `OuterElement`
component as `outerElementType` precisely to host the sticky header
*inside* react-window's own scroll container. There is no v2 prop that
does that, and `children` is not a substitute — it renders as an
overlay on top of row 0 rather than above it in flow.

So the structure inverted: a flex column owns the horizontal scroll,
the header is its first child in normal flow, and the `List` is the
second child scrolling vertically in the remaining space. The header
stays put while rows scroll under it — the same visual contract,
reached structurally instead of with `position: sticky`. That deleted
the "ref-as-mailbox" apparatus v1 needed (header state smuggled
through a mutable ref written during render, behind two
`eslint-disable` blocks), because a sibling just takes props.

Two more v2 behaviours are worth knowing before editing either seam,
because both are hazards the port had to absorb rather than wins:

- **`List` sets `role="list"` on its scroller; v1 set no role.** Inside
  the combobox — `role="listbox"` outside, `role="option"` rows inside
  — a `list` in between is invalid ARIA and breaks the option count
  screen readers announce. The primitive therefore takes a `role` prop
  and `virtualized-options.tsx` passes `"presentation"` to erase it.
  It must be spread CONDITIONALLY: react-window builds its root as
  `{ role: 'list', ...rest }`, so a `role` key present with an
  `undefined` value wins the spread and silently erases the default for
  every consumer that never asked.
- **`scrollToRow` throws on an out-of-range index.** The combobox
  scrolls to its active index while the option list is being filtered
  underneath it, so this fires in ordinary use; an exception out of
  that effect would take the whole panel down. The primitive's handle
  range-checks before delegating.

### The blast radius — two seams, deliberately independent

Exactly two files import `react-window`, and neither is built on the
other:

- `src/components/ui/virtualized-list.tsx` — imports `List`,
  `type ListImperativeAPI` and `type RowComponentProps`. One direct
  importer downstream:
  `src/components/ui/combobox/virtualized-options.tsx`.
- `src/components/ui/table/virtual-table-body.tsx` — imports `List`
  and `type RowComponentProps` directly, NOT `<VirtualizedList>`. Two
  direct importers downstream: the barrel
  `src/components/ui/table/index.ts` and
  `src/components/ui/table/data-table.tsx`.

The independence is a decision, not an oversight: the header comment
in `virtual-table-body.tsx` records that a `<tbody>` cannot nest the
primitive's own scroll container, so `<VirtualTable>` reproduces the
table contract with `display: grid` div semantics instead. Both seams
had to be ported, and they could not be ported as one.

`tests/unit/react-window-hold.test.ts` pins the post-migration state —
the v2 major in `package.json`, the lockfile and the installed tree;
the absence of both removed packages from package files, lockfile and
import sites; the seam set with the v2 identifiers each seam depends
on; that no v1-only identifier (`FixedSizeList`, `VariableSizeList`,
`ListChildComponentProps`) is imported anywhere under any alias; and
that nothing passes `outerElementType`, which on v2 would be an inert
prop spread onto a DOM div. A third importer, a partial revert, or a
re-added auto-sizer turns it red, which is the signal that this
section needs re-arguing in the same PR.

Two details of that test are worth knowing before editing either half.
The seam scan is **repo-wide and AST-based**, not a grep over `src/`:
thirteen files in this repository contain the string `react-window` and
only two depend on it, so a text search answers this question wrongly
by eleven. It counts a dynamic `import()` and a `require()` as
dependencies too, since neither is an `ImportDeclaration`. And it
asserts on values computed from that AST rather than on file text, so
it joins neither the Class A nor the Class D assertion-reach
population and spends none of their zero-allowance budget — which is
why its predecessor could be written at all after the #2552 draft was
dropped for exactly that cost (#2646).

### What the migration bought

- **Two dependencies disappeared.** `@types/react-window@2.0.0` is a
  published stub — its own npm metadata reads *"This is a stub types
  definition. react-window provides its own type definitions, so you
  do not need this installed."* And `react-virtualized-auto-sizer`
  (`^2.0.3`) became redundant: v2's `List` IS the scroll container and
  observes its own box, so the four-branch AutoSizer matrix in
  `virtualized-list.tsx` is gone and the second dependency with it.
  This was the largest concrete win.
- **Fewer transitive deps.** v1.8.11 depended on `@babel/runtime` and
  `memoize-one`; v2.3.3 declares no runtime dependencies at all.
  `memoize-one` left the lockfile with it. `@babel/runtime` did not —
  other packages still pull it, which is the ordinary case and the
  reason this bullet names the lockfile rather than a count.
- **Less hand-memoisation.** v2 memoises row renderers and props
  itself, and the header restructure removed the stable-identity
  `useMemo([])` that `outerElementType` forced.
- **A smaller package.** v1 ships an 83,002-byte `dist/index.cjs.js`;
  v2.3.3 ships a 15,390-byte `dist/react-window.cjs`. Those are
  on-disk package bytes, **not** measured application bundle weight —
  the honest number needs a before/after bundle analysis, and nobody
  has run one. The claim here is the package got smaller, which is
  measurable; that the app's bundle did is not claimed.

### What it did not buy — the forcing functions, still absent

Re-checked at the time of the port. None of these is why the bump
happened, and recording that keeps the next reader from inferring an
urgency that was never there:

- **No security fix.** `npm audit --omit=dev
  --audit-level=moderate` reported `react-window` at no severity on
  either side of the bump, and `security/audit-allowlist.json` holds no
  `react-window` entry. `dependency-review-action` on #2543 reported
  no vulnerability for 2.x either.
- **No compatibility need.** v1 declared peers `react` `^15 || ^16 ||
  ^17 || ^18 || ^19` and the lockfile resolves `react` at 19.3.0; the
  React 19 bump had not stranded us. v2 narrows its peers to `^18 ||
  ^19`, which is a tightening, not a fix for anything we hit.
- **No end of life.** `react-window@1.8.11` carried no `deprecated`
  field. npm's `latest` pointed at 2.x, which makes v1 *not the
  newest* — a different claim from *unmaintained*.

The reason was the fourth condition: both wrappers needed substantial
work anyway, for the upstream sync, which made the rewrite marginal
rather than additional.

### The risk, and how to get out

**Risk.** 954 lines of wrapper (`virtualized-list.tsx` 295,
`virtual-table-body.tsx` 659) that `<DataTable>`, `<VirtualTable>` and
`<Combobox>` all sit on. The wrappers exist exactly so this stays
swappable — `virtualized-list.tsx`'s header states the intent
("consumers never import react-window directly") — so the blast radius
is contained to two files plus their three downstream importers.
Contained is not free. The specific failure modes, each with the thing
that would catch it:

| Failure | What catches it |
|---|---|
| The list collapses to 0px and renders only its overscan rows | The windowing assertions in `tests/rendered/virtualized-list.test.tsx` and `virtual-table-body.test.tsx` are floored at the viewport's own row count, not at `> 0` |
| Header and body columns drift apart | `virtual-table-body.test.tsx` asserts both read the SAME `gridTemplateColumns` string |
| Load-on-scroll stops at the virtualization threshold | `tests/rendered/data-table-virtualize.test.tsx` fires `onReachEnd` on the windowed path and asserts the once-per-row-count latch |
| The combobox announces the wrong option count | `virtualized-list.test.tsx` asserts `role="presentation"` erases v2's `list` role and that rows carry none of react-window's own ARIA |
| A partial revert leaves v1 symbols against a v2 install | `tests/unit/react-window-hold.test.ts` |

**Rollback.** Revert the PR. The change is self-contained — two
wrappers, `data-table.tsx`'s props, the table files' comments, the
package files, this section, and the tests — and it carries no
migration, no persisted state and no API shape visible outside the
`ui/table` and `ui/combobox` modules. `COLUMN_VISIBILITY_PREFIX` is
rebuilt from `uiStorageKey('col-vis')` in the same change and its
VALUE is unchanged, so nothing in a user's `localStorage` is
invalidated in either direction. A revert restores `^1.8.11`,
`@types/react-window@^1.8.8` and `react-virtualized-auto-sizer@^2.0.3`
with the lockfile, and `react-window-hold.test.ts` has to go back to
its v1 predecessor in the same commit — the test is the thing that
would otherwise be left asserting the state the revert removed.

### When to revisit

The version is held at a caret on 2.x, which cannot cross a major.
What would reopen the question:

- an advisory lands against `react-window` v2 (the `npm audit` gate
  makes this loud, and `security/audit-allowlist.json` is the wrong
  answer for an advisory with a fixed version available);
- v2 drops a `react` major we run;
- a v3 appears. It gets the same treatment this did: the section is
  re-argued in the PR that bumps it, with the seam set and the
  identifier table brought up to date, and not merged because a
  dependabot PR went green.


## The CI surface

The `Security` job in `.github/workflows/ci.yml` is the runtime
enforcement layer the guardrails complement:

- **`dependency-review-action`** (PR-only) — flags a newly
  introduced dependency that carries a known advisory, before it
  merges.
- **`npm audit --omit=dev --audit-level=moderate`** — **blocking**.
  A MODERATE+ advisory in the production dependency tree fails the
  merge. Its strictness is itself ratcheted by
  `tests/guardrails/security-gate-strictness.test.ts`.
- **`npm audit` (all deps)** — informational; surfaces dev-tree
  advisories as a warning without blocking.

Structural guardrails catch *drift* (a re-introduced flag, a version
skew, a misclassified package); the `Security` job catches *new
advisories*. Both layers are load-bearing.

## See also

- `docs/dependency-policy.md` — install-time policy: strict peers,
  `npm ci`, the `overrides` table, Node/npm pinning.
- `docs/dependency-risk-review.md` — the package-by-package risk
  review and the reusable audit template.
