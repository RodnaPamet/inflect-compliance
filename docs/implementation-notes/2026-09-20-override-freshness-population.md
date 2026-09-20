# 2026-09-20 — overrides behind their own ranges (#2545)

## Design

`#2545` reported five overrides lagging their own ranges. Re-measured against
the branch base (`4e06806b0`) on 2026-09-20, **all five had already been
brought forward on `main`** — every one of them already carried the exact
version the issue's own table listed as "available in range", so **0 of the 5
rows were still true**:

| Package | issue: locked | issue: available in range | base lockfile |
| --- | --- | --- | --- |
| `mysql2` | 3.24.3 | 3.24.4 | **3.24.4** |
| `valibot` | 1.4.2 | 1.5.0 | **1.5.0** |
| `@typescript-eslint/parser` | 8.69.0 | 8.70.0 | **8.70.0** |
| `typescript-eslint` | 8.69.0 | 8.70.0 | **8.70.0** |
| `nanoid` | 3.3.18 | 3.3.19 | **3.3.19** |

(Reproduce by reading `package-lock.json` at `4e06806b0` for each name, taking
every `node_modules/**/<name>` entry outside `node_modules/npm/node_modules/`
— the same carve-out the script applies.)

So the issue was 100% stale, not 80%: nothing it named needed doing, and the
one override that WAS genuinely behind is one it never named — `@grpc/grpc-js`,
override `^1.14.4`, lockfile 1.14.4, newest-in-range 1.14.5 — a `security`
entry in the production tree, pulled by the OpenTelemetry gRPC exporter.

Denominator for that measurement: **53 override entries** (41 top-level keys,
of which 16 hold nested objects). 1 LAGGING, 3 inert, 9 current-with-a-newer-
release-outside-the-range, 40 current. After the bump: **0 LAGGING**.

The bump alone leaves the class open, so the substantive change is to the
detector's POPULATION.

`scripts/check-override-freshness.mjs` enumerated only TOP-LEVEL string
entries, so every nested pin (`{ jsdom: { ws: '^8.21.0' } }`) fell outside it.
Two survived deduplication against the top-level keys and were therefore
watched by nothing at all:

| Entry | Spec | Why nothing else covers it |
| --- | --- | --- |
| `jsdom > ws` | `^8.21.0` | no top-level `ws` override; `ws` is not a direct dependency, so Dependabot does not move it either |
| `@istanbuljs/load-nyc-config > js-yaml` | `^3.15.2` | its own registry entry calls this a security floor — "the 3.x branch of the SAME advisory" as the top-level `js-yaml` key |

Nothing was red. The script printed *"All version-forcing overrides are at the
newest release their range permits"* — true of the population it selected, and
the selection was the defect.

`$name` overrides stay exempt, because they force whatever the matching DIRECT
dependency requests and cannot drift from a range they are defined as equal to.
The exemption is now checked rather than assumed: a `$ref` resolving to nothing
silently disables its override, so the guard asserts every exempt entry names a
real direct dependency.

## Files

| File | Role |
| --- | --- |
| `package-lock.json` | `@grpc/grpc-js` 1.14.4 → 1.14.5, within the existing `^1.14.4` range. No range widened. |
| `scripts/check-override-freshness.mjs` | `nestedVersionForcingOverrides()` (recursive, any depth) + `freshnessPopulation()` (dedup on `(name, spec)`, top-level key wins the label); `--print-population`; one `FRESHNESS_POPULATION` binding shared by the dump and the loop; `analysableRange()` + the `unanalysable` finding level so no entry leaves the loop unreported |
| `tests/guards/override-freshness-population.test.ts` | new guard — the offline half |

## Decisions

- **The lockfile was updated with `npm update <pkg> --package-lock-only`, and
  that flag does NOT leave `node_modules` alone.** Measured, not assumed: it
  rewrote `node_modules/.package-lock.json` (npm's hidden lockfile). The
  installed package directories were untouched, but on a shared `node_modules`
  the hidden lockfile is shared state. Run it with `node_modules` pointed
  somewhere private if peers have work in flight.

- **Use the repo's own npm major.** npm 10 stripped 36 `libc` blocks that npm
  11 had written — a 3-insertion change arriving as `3 insertions, 111
  deletions`. Re-run under Node 24 / npm 11 the diff is exactly the three
  `@grpc/grpc-js` lines. The diffstat is the tell; the file list is not.

- **The guard SHELLS OUT to the script rather than re-deriving its rule.**
  Re-implementing the selection in the test would make the test grade its own
  copy — the script could narrow to nothing and the test would still agree with
  itself. `--print-population` exits above every `await`, so this is offline and
  takes milliseconds.

- **One `FRESHNESS_POPULATION` binding, two readers.** Calling the selector
  separately in the dump and in the freshness loop would let the LOOP narrow
  while the dump kept printing the full set — the guard would watch a population
  the detector need not iterate. This was found by asking what mutation the
  guard would MISS, not by reading the diff.

- **The guard also carries the offline half of #2545's own question.** Knowing a
  newer version exists upstream needs the registry, but when the lockfile
  carries TWO versions of a package and the override range admits both, the
  lockfile is its own witness — the newer one demonstrably exists, demonstrably
  satisfies the range, and an instance is still below it. Zero instances of that
  shape today, across all 26 literal entries.

- **The advisory half stays top-level only.** The registry is keyed by package
  name and holds one entry per package, so including nested pins there would
  re-resolve the same recorded id and emit duplicate findings for `js-yaml` and
  `brace-expansion`. One advisory question per recorded fact.

- **Widening the population added no noise.** Post-change the script reports
  zero `lagging`, zero `advisory`, zero `floor`, zero `skip` — the two new
  entries contribute one informational `outside` notice (`js-yaml ^3.15.2`,
  whose 3.x line is deliberate). Zero `skip` findings is also the positive
  control that the advisory API answered rather than rate-limiting.

- **Both flatteners recurse, because fixing only one is undetectable.** npm's
  `overrides` nest without limit, and the first cut of this change read exactly
  ONE level below a top-level key — on BOTH sides. The guard's denominator
  therefore shared the detector's blind spot and the two agreed perfectly about
  a set that excluded depth 3: adding
  `{ 'jest-environment-jsdom': { jsdom: { ws: '^7.0.0' } } }` to `package.json`
  left the population at 24 and the guard passing 14/14 (measured). A
  denominator derived with the detector's own limitation is not a denominator,
  so the recursion landed in `nestedVersionForcingOverrides()` and in
  `allOverrideEntries()` together. Neither flattener reads a fixed depth now,
  and both resolve npm's `.` self-key against the parent trail.

- **Three entries were being dropped with no finding at all, and that is now
  an `unanalysable` level.** `satisfiesCaret` returns `null` for any range that
  is not `^X.Y.Z`; the loop filters on `=== true`, so an exact pin
  (`sharp 0.35.4`, `@conventional-changelog/template 1.3.0`) or a conjunction
  (`nwsapi >=2.2.16 <2.2.25`) produced an empty in-range set, both drift
  branches went unreachable, and the entry vanished from the report. Three of
  the 24. A silent drop reads exactly like a pass — the same defect as the
  narrowed population, one level down — so the loop now emits a finding naming
  the entry, the headline and the job summary both carry the
  `N of 24 NOT analysed` denominator, and `--self-test` pins the predicate
  (an `analysableRange` that answered `true` for everything would restore the
  silent drop).

  It is a NEW level rather than a `skip` on purpose: `skip` means "the lookup
  failed", and `override-freshness.yml` documents zero `skip`s as the positive
  control that the advisory API answered rather than rate-limiting. Three
  permanent `skip`s would have destroyed that control. `unanalysable` is
  likewise outside `ESCALATES` — an exact pin is a deliberate choice, not a
  lag.

- **`lockedVersions` is keyed by PACKAGE NAME, and for a nested pin that is the
  wrong instance.** It returns every copy of the package in the tree and the
  loop takes the max, which is right for a bare top-level override (it rewrites
  them all) and wrong for a nested pin (it constrains only the copy its parent
  resolves). Concretely: `@istanbuljs/load-nyc-config > js-yaml ^3.15.2`
  governs `node_modules/@istanbuljs/load-nyc-config/node_modules/js-yaml` at
  3.15.2, but the report prints `locked: 5.4.2` — the hoisted root copy — and
  because 5.4.2 exceeds every 3.x, the `lagging` branch is **unreachable** for
  that entry however far behind the real instance falls. `jsdom > ws ^8.21.0`
  comes out right by accident (its constrained instance IS the newest copy).

  Not fixed here, deliberately. Doing it properly means resolving each parent's
  own lockfile path(s) and replaying npm's directory walk from them, plus
  matching requested ranges for the selector keys (`js-yaml@>=4.0.0 <4.3.2`) —
  and the cheap version is WORSE than the bug: restricting to
  `node_modules/<parent>/node_modules/<child>` finds nothing for a hoisted
  instance, so the entry reads as inert and is dropped silently, re-opening
  exactly what this PR closed. The limitation is written into the
  `lockedVersions` docblock and into the guard's, so `locked` on a nested pin
  reads as "newest copy anywhere", never "the copy this pin governs".
