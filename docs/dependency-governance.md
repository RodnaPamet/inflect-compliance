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

## react-window — stay on v1 until something forces v2

`react-window` is `^1.8.11` (`package.json:173`) with the v1-era
`@types/react-window` `^1.8.8` (`package.json:212`). Dependabot
proposed `1.8.11 → 2.3.1` (with `@types/react-window 1.8.8 → 2.0.0`)
in PR #2543; it was closed deliberately on 2026-09-17, and this
section is the record so the next bump re-argues the decision instead
of rediscovering it. Issue #2552 tracks the same reasoning.

**v2 is an API rewrite, not a version bump.** Every v1 export this
repo imports is gone. Checked against the published
`react-window@2.3.1` type definitions (`dist/react-window.d.ts`):
`FixedSizeList`, `VariableSizeList` and `ListChildComponentProps`
appear zero times in it. What v2 exports instead is a single `List`
(plus `Grid`), driven by differently-named props:

| v1, as used here | v2 equivalent |
|---|---|
| `FixedSizeList` + `VariableSizeList` | one `List`, with `rowHeight: number \| string \| (index) => number \| DynamicRowHeight` |
| `ListChildComponentProps` | `RowComponentProps` |
| children-as-component | `rowComponent` prop |
| `itemCount` / `itemSize` / `itemData` | `rowCount` / `rowHeight` / `rowProps` |
| `onItemsRendered({ visibleStopIndex, … })` | `onRowsRendered({ startIndex, stopIndex }, allRows)` |
| ref `.scrollToItem(index, align)` | `listRef.scrollToRow({ index, align, behavior })` |
| `outerElementType` / `innerElementType` | **no equivalent** — v2 has `tagName` (a tag NAME, not a component) plus `children` rendered above the rows |

That last row is the load-bearing one.
`src/components/ui/table/virtual-table-body.tsx:505` passes a
memoised `OuterElement` component as `outerElementType` precisely to
host the sticky header *inside* react-window's own scroll container.
A v2 port has to rebuild that from a different primitive, which is
design work rather than a rename.

### The blast radius — two seams, deliberately independent

Exactly two files import `react-window`, and neither is built on the
other:

- `src/components/ui/virtualized-list.tsx:50-54` — imports
  `FixedSizeList`, `VariableSizeList` and `type ListChildComponentProps`.
  One direct importer downstream:
  `src/components/ui/combobox/virtualized-options.tsx:52-54`.
- `src/components/ui/table/virtual-table-body.tsx:58` — imports
  `FixedSizeList` directly, NOT `<VirtualizedList>`. Two direct
  importers downstream: the barrel `src/components/ui/table/index.ts:24`
  and `src/components/ui/table/data-table.tsx:35`.

The independence is a decision, not an oversight: the header comment
at `virtual-table-body.tsx:12-26` records that a `<tbody>` cannot nest
the primitive's own scroll container, so `<VirtualTable>` reproduces
the table contract with `display: grid` div semantics instead. Both
seams therefore have to be ported, and they cannot be ported as one.

`tests/unit/react-window-v1-hold.test.ts` pins both halves — the v1
major in `package.json`, the lockfile and the installed tree, plus the
seam set with the v1 identifiers each seam depends on. A third
importer, or a bump to v2, turns it red, which is the signal that this
section needs re-arguing in the same PR.

Two details of that test are worth knowing before editing either half.
The seam scan is **repo-wide and AST-based**, not a grep over `src/`:
nine files in this repository contain the string `react-window` and
only two depend on it, so a text search answers this question wrongly
by seven. It counts a dynamic `import()` and a `require()` as
dependencies too, since neither is an `ImportDeclaration`. And it
asserts on values computed from that AST rather than on file text, so
it joins neither the Class A nor the Class D assertion-reach
population and spends none of their zero-allowance budget — which is
why it could be written at all after the #2552 draft was dropped for
exactly that cost (#2646).

### What the migration would buy

- **Two dependencies disappear.** `@types/react-window@2.0.0` is a
  published stub — its own npm metadata reads *"This is a stub types
  definition. react-window provides its own type definitions, so you
  do not need this installed."* And `react-virtualized-auto-sizer`
  (`^2.0.3`, `package.json:172`, imported at
  `virtualized-list.tsx:55` and `virtual-table-body.tsx:59`, with no
  other import site in `src/`) becomes redundant: a v2 `List` sizes
  itself from its parent via `defaultHeight` + `onResize`. This is
  the largest concrete win.
- **Fewer transitive deps.** v1.8.11 depends on `@babel/runtime` and
  `memoize-one`; v2.3.1 declares no runtime dependencies at all.
- **Less hand-memoisation.** v2 memoises row renderers and props
  itself. Today that is done by hand at six call sites in
  `virtual-table-body.tsx` (`React.useMemo` at 352, 364, 378, 382,
  435; `React.useCallback` at 485) and one in
  `virtualized-list.tsx:160`.
- **A smaller package.** v1 ships an 83,002-byte `dist/index.cjs.js`
  (25,049 bytes for its production UMD build); v2 ships a single
  13,149-byte `dist/react-window.cjs`. Those are on-disk package
  bytes, **not** measured application bundle weight — the honest
  number needs a before/after bundle analysis, and nobody has run one.

### What it would not buy — every forcing function, checked and absent

Re-checked 2026-09-19:

- **No security fix.** `npm audit --omit=dev --audit-level=moderate`
  over this lockfile reports `react-window` at no severity at all —
  run 2026-09-19, and the run is only evidence because it reached the
  registry and came back with findings: the two it does report are the
  `image-size` / `pptxgenjs` pair already carried in
  `security/audit-allowlist.json`, which holds no `react-window` entry.
  `dependency-review-action` on #2543 reported no vulnerability for
  `2.3.1` either — so the advisory ledger is empty on *both* sides of
  the bump.
- **No compatibility need.** `react-window@1.8.11` declares peers
  `react` / `react-dom` `^15 || ^16 || ^17 || ^18 || ^19`, and the
  lockfile resolves `react` at `19.3.0`. The React 19 bump did not
  strand us. (v2 narrows its peers to `^18 || ^19`, which is a
  tightening, not a fix for anything we hit.)
- **No end of life.** `react-window@1.8.11` carries no `deprecated`
  field in its published `package.json`. npm's `latest` dist-tag
  points at `2.3.1`, which makes v1 *not the newest* — a different
  claim from *unmaintained*.

### What it would cost

991 lines of wrapper (`virtualized-list.tsx` 313,
`virtual-table-body.tsx` 678) rewritten across two shared primitives
that `<DataTable>`, `<VirtualTable>` and `<Combobox>` all sit on, plus
the call sites above. The wrappers exist exactly so this stays
swappable — `virtualized-list.tsx:10` states the intent ("consumers
never import react-window directly") — so the blast radius is
contained. Contained is not free.

### When to revisit

Any one of these flips the answer, and each is a condition someone
can check rather than a matter of taste:

- an advisory lands against `react-window` v1 (the `npm audit` gate
  makes this loud, and `security/audit-allowlist.json` is the wrong
  answer for an advisory with a fixed version available);
- v1 is marked `deprecated` upstream, or drops a `react` major we run;
- a measured bundle problem lands in which the react-window payload is
  a material part — measured, per the caveat above;
- either wrapper needs substantial work anyway, which makes the
  rewrite marginal rather than additional.

Absent one of those this is housekeeping with no deadline. When it is
done, it gets done deliberately, with a before/after bundle
measurement and both seams ported in one change — not merged because a
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
