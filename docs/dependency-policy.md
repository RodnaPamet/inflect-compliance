# Dependency installation policy

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md) — the developer onboarding guide.

> Part of the dependency-governance model — see
> `docs/dependency-governance.md` for the four-pillar overview, the
> contributor lifecycle (adding / upgrading / removing a
> dependency), and the NextAuth stay-on-v4 policy. This document is
> the **install-time** layer: strict peers, `npm ci`, the
> `overrides` table, Node/npm pinning.

## Strict peer-dependency resolution

Installs are **strict**. No install path passes `--legacy-peer-deps`.
npm validates the peer-dependency graph on every `npm install` /
`npm ci`, so an incompatible package combination fails fast instead
of being silently absorbed.

`--legacy-peer-deps` used to be on every install step (`Dockerfile`,
all `.github/workflows/*`). It disabled peer validation wholesale —
which masked real incompatibilities. Removing it surfaced three
genuine conflicts left behind by the Next 14 -> 16 and React 18 ->
19 migrations; all three are now resolved (see below).

The ratchet `tests/guards/no-legacy-peer-deps.test.ts` fails CI if
the flag re-enters any install path.

## Resolved conflicts

| Conflict | Cause | Resolution |
|----------|-------|------------|
| `@visx/*@3.x` vs React 19 | visx 3.x (the latest stable line) peers `react ^16 \|\| ^17 \|\| ^18`; visx 4 — which adds React 19 — is alpha-only. The repo runs `react@19`. | `overrides` block: each `@visx/*` package's `react` / `react-dom` pinned to the root version (`$react` / `$react-dom`). visx 3.x is a set of stateless SVG renderers and runs correctly under React 19 — the override records that verified fact. |
| `eslint-config-next@16` vs `eslint@8` | The Next 16 upgrade bumped `eslint-config-next` to 16, which peers `eslint >=9`; `eslint` was left at 8 (now end-of-life). | `eslint` bumped to `^9`. The lint setup already uses flat config (`ESLINT_USE_FLAT_CONFIG=true`), so eslint 9 — where flat config is the default — is a natural fit. |
| `next-auth@4` vs `next@16` / `nodemailer@7` | `next-auth@4` peers `next ^12 \|\| ^13 \|\| ^14` and (optionally) `nodemailer ^6`. The repo runs `next@16` and `nodemailer@7`. | `overrides` block: `next-auth`'s `next` and `nodemailer` pinned to the root versions. NextAuth v4 is the supported stable line here; it operates correctly on next 16 / nodemailer 7. |

## The `overrides` block

`package.json` carries an `overrides` block that pins the peers
above to the real installed versions. This is deliberately
**granular** — it names exactly which peer mismatches are accepted,
and why (this document). It is the opposite of the blanket
`--legacy-peer-deps`: every *other* package's peers are still
validated strictly, so a new incompatible dependency is caught at
install time.

When a package in the table ships a release whose peer range
genuinely includes the version we run, drop its `overrides` entry —
the override is a bridge, not a destination.

## Security overrides

`overrides` also force a **patched transitive dependency** when an
advisory lands against a version pulled in by a package we don't
control. The CI `Security` job (`npm audit --omit=dev
--audit-level=moderate`) blocks merges on MODERATE+ advisories in
production deps, so an un-fixable transitive CVE would otherwise
wedge the whole pipeline.

The per-override reason, advisory id, and the version each fix landed
in are recorded in `OVERRIDE_REGISTRY` in
`tests/guards/overrides-effective.test.ts` — kept next to the check
that enforces them so the two cannot drift apart. `uuid` is the
worked example:

| Override | Advisory | Why |
|----------|----------|-----|
| `uuid` → `^11.1.1` | GHSA-w5hq-g745-h8pq — missing buffer bounds check in uuid v3/v5/v6 when `buf` is provided (moderate) | `next-auth@4` declares `uuid@^8.3.2`; the whole `<11.1.1` line is vulnerable, so the only fix is forcing the patched major. `next-auth` uses the version-stable named `uuid` exports (`v4`, …), which are unchanged v8 → v11. Drop this entry if `next-auth` itself moves to a patched `uuid` range. |
| `sharp` → `0.35.3` | GHSA-f88m-g3jw-g9cj — sharp `<0.35.0` inherits libvips CVEs CVE-2026-33327 / 33328 / 35590 / 35591 (high) | `next@16.2.10` pulls `sharp@0.34.5` transitively for image optimisation; the whole `<0.35.0` line is vulnerable. `sharp` 0.35.x is a drop-in for Next's optimiser (same API surface), so force the patched `0.35.3`. Drop this entry once `next` itself depends on `sharp >=0.35.0`. |

A security override is NOT a bridge to drop on convenience — keep it
until the upstream package legitimately depends on a patched range.

### Overrides decay silently — two mechanisms, two checks

**Raising a floor does not move the lockfile.** `hono` was pinned
`^4.12.23`. The range admitted the patched 4.12.31. The lockfile was
never refreshed, so the tree sat on vulnerable 4.12.25 for weeks while
every offline signal read "remediated". Bumping the range in
`package.json` and running `npm update <pkg>` are two different
actions; the second is the one that matters.

**An override can rewrite nothing at all.** `tar` is pinned `^7.5.18`,
but the only `tar` in the tree lives inside npm's *bundled*
dependencies — and npm ships those prebuilt, so no override can reach
them. What actually keeps that copy safe is the `npm` pin (raised to
`^11.18.0`, whose bundle carries tar 7.5.19 and brace-expansion 5.0.7),
not the `tar` entry. An override that reads as protection while
protecting nothing is worse than no override.

**A floor stops excluding anything when a follow-up advisory lands.**
`tmp` was pinned `^0.2.6` for a traversal fixed in 0.2.6 — then a
second advisory landed affecting 0.2.6 itself. `protobufjs` was pinned
`^8.2.0` for a fix in 8.2.0, later superseded by one in 8.6.6. Both
floors still *looked* like remediation, and `npm audit` stayed green
because the lockfile happened to sit on something patched. The floor,
not just the lockfile, has to be re-checked when a package already
pinned here gets a new advisory.

**A recorded advisory id can be wrong.** Four registry entries once
cited advisories that were shape-valid and substantively wrong:
`picomatch` carried an `ip` SSRF id, `tmp` carried an id that does not
exist, and `protobufjs` / `@grpc/grpc-js` carried real advisories
patched in majors far below the floors they were justifying. Nothing
offline can tell the difference.

Two complementary checks cover these:

| Check | Runs | Catches |
|---|---|---|
| `tests/guards/overrides-effective.test.ts` | every CI run, offline | unregistered override · a floor lowered below the recorded fix · an override that rewrites nothing (must be declared `currentlyInert` with a reason) · a stale inert note · a malformed registry entry |
| `.github/workflows/override-freshness.yml` | weekly + manual, hits the npm registry and the GitHub Advisory Database | the hono shape — a newer version exists *inside* the range but the lockfile is behind · a floor that is **itself** still affected by some advisory · a recorded advisory id that does not resolve, covers a different package, or was fixed in a version other than `patchedFrom`. Also notes when the newest release sits *outside* the range. |

The split is deliberate: a Jest guard must not make network calls, and
the registry / advisory database is the only place the "is there a
newer fix?" and "is this advisory even real?" answers live. The
workflow is **non-blocking** — it warns and maintains one tracking
issue. `npm audit` remains the gate that blocks merges, because it
blocks on evidence of a real advisory rather than on version
arithmetic.

The registry itself lives in `tests/guards/override-registry.json` —
data, read by both halves. It is JSON rather than an inline literal
precisely so the network half can verify the same facts the offline
guard asserts, instead of re-declaring them and drifting.

Note that **Dependabot does not update `overrides`** — it moves
declared dependencies. That is exactly the gap the weekly job covers.

Run it locally with:

```bash
node scripts/check-override-freshness.mjs        # warn-only
node scripts/check-override-freshness.mjs --json # machine-readable
node scripts/check-override-freshness.mjs --self-test  # prove the comparators work
```

`GITHUB_TOKEN` is picked up when set. Without it the advisory API
allows 60 requests/hour — enough for one local run, not for a busy
runner, and a rate-limited run reports `skip` rather than a clean bill
of health. Locally: `GITHUB_TOKEN=$(gh auth token) node scripts/…`.

**The comparators are self-tested.** Every finding depends on two
hand-rolled version comparators, and one that returns "not affected"
unconditionally would report all-clear forever. `--self-test` pins
their behaviour and runs as a blocking step in the workflow before the
report is believed — it caught exactly that bug on the day the
advisory checks were written (GitHub writes `>= 0.2.6, < 0.2.7` with a
space after the operator, which the first tokenizer split into bare
operators, making every range read as "unknown").

## Deterministic installs — `npm ci`

Every install path — the `Dockerfile` and all CI workflows — runs
**`npm ci`**, never `npm install`:

| | `npm install` | `npm ci` |
|---|---|---|
| Lockfile | may be **mutated** (re-resolves semver ranges) | read-only; install fails if it drifts from `package.json` |
| Reproducibility | two runs of one commit can differ | identical tree every run |
| Corrupt lockfile | silently "repaired" | **surfaced** as a hard error |

`npm ci` is therefore both the install command AND the
lockfile-integrity check — there is no separate CI step for it. A
stale or hand-mangled `package-lock.json` fails fast in every job
instead of being papered over.

Enforced by `tests/guards/deterministic-install.test.ts`, which
fails CI if any install path reverts to `npm install`.

### A worked example — the `@next/swc-*` corruption

Adopting `npm ci` immediately surfaced a real defect that
`npm install` had been masking: a stale `optionalDependencies`
block in `package.json` pinned all nine `@next/swc-*` platform
binaries to the **Next 14** version `14.2.35` — a leftover from the
Next 14 → 16 migration, never updated. `@next/swc-*` are `next`'s
own transitive optional dependencies; a consumer project must never
pin them. The stale block conflicted with `next@16.2.6`'s own SWC
deps and corrupted the lockfile — exactly the kind of
incompatibility `npm install` absorbs silently. The fix: delete the
block — `next` resolves its own platform binaries.

`tests/guards/swc-version-coherence.test.ts` now makes the skew
unrepeatable: it fails CI if `package.json` pins any `@next/swc-*`
package directly, or if any `@next/swc-*` entry in the lockfile
carries a version other than the resolved `next` version. Re-add a
pin and the platforms desynchronise from `next` — the guard catches
it before merge.

## Node / npm

Node **24** across every environment, pinned in three places that
`deterministic-install.test.ts` keeps in agreement:

- **`.nvmrc`** (`24`) — `nvm` / `fnm` auto-select it.
- **`engines`** in `package.json` (`node >=24.0.0 <25.0.0`) —
  declares the supported runtime; npm warns on a mismatch.
- **CI / container** — `NODE_VERSION` in `ci.yml`, the literal
  `"24"` in the other workflows, and the `node:24-alpine` base image
  in the `Dockerfile`.

npm ships with Node 24, so no separate npm install step is required
for the app. The `Dockerfile`'s runner stage does pin a newer npm
(`npm install -g npm@<version>`) — that is a *container-image* CVE fix
for the npm CLI vendored in the base image, a surface `package-lock.json`
cannot reach. npm itself is not removable there: the entrypoint runs
`npx prisma migrate deploy` on container start.
