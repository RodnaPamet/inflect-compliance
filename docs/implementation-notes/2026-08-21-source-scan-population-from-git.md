# 2026-08-21 — source scans take their population from git, not from a skip list

**Commit:** `(this PR)` fix(guardrails): take source-scan populations from git, not a skip list

## The failure

`tests/guardrails/prisma-schema-folder-coverage.test.ts` walked the repo root
with `fs.readdirSync` and skipped `['node_modules', '.next']`. It did not skip
`.claude/` (`.gitignore:136`), and `.claude/worktrees/<id>/` holds a FULL
checkout of the repo. With any worktree present the guard read the worktree's
copies of ITSELF and of its own helper, and reported them:

```
2 file(s) read the legacy prisma/schema.prisma path directly:
  - .claude/worktrees/<id>/tests/guardrails/prisma-schema-folder-coverage.test.ts
  - .claude/worktrees/<id>/tests/helpers/prisma-schema.ts
```

Both are copies of files that are fine in the real tree — the guardrail was
reporting itself. CI has no worktrees, so it was green there and red only for
whoever was using them. That is the worst place for a failure to live: it costs
a local hour and never appears where anyone would fix it.

## Survey — what the class actually looks like

212 files under `tests/guards` + `tests/guardrails` + `tests/helpers` call
`readdirSync`. Grouped by the directory names they skip:

| skip list | files |
| --- | --- |
| *(none)* | 96 |
| `node_modules` | 68 |
| `node_modules`, `.next` | 45 |
| `node_modules`, `.next`, `dist` | 2 |
| `build` | 1 |

Five shapes for one question. The divergence is the finding: nobody maintains
these lists, they are copy-paste sediment, and none of them had heard of
`.claude/`.

**Exposure is narrower than the count suggests.** `.claude/` sits at the repo
root, so only a walk *rooted at the repo root* can reach it — the 96 "no skip
list" files are almost all walking `src/…` and cannot. Three files rooted at the
repo root:

| file | shape | reached `.claude/`? |
| --- | --- | --- |
| `tests/guardrails/prisma-schema-folder-coverage.test.ts` | recursive `walk(REPO_ROOT)` | **yes — the reported bug** |
| `tests/guards/deterministic-install.test.ts` | non-recursive `readdirSync(ROOT)`, filtered `^Dockerfile` | no (a directory never matches) |
| `tests/guards/no-legacy-peer-deps.test.ts` | same | no |

Confirmed empirically, not by reading: a real `git worktree add` under
`.claude/worktrees/` and then the whole ratchet job — **648 suites, 9,085 tests
— produced exactly one failure**, the one above.

Three more hand-maintained ignore lists in the same class were missing `.claude`
and are fixed here: Jest's `testPathIgnorePatterns` (it discovered and ran both
copies of every test, and emitted `jest-haste-map: duplicate manual mock found`,
which makes which mock wins nondeterministic), ESLint's `ignores`, and
`tsconfig.json`'s `exclude` (`include: ["**/*.ts"]` handed tsc a second copy of
the project). `.dockerignore` too — worktrees were being shipped into the build
context.

## Design

`tests/helpers/repo-files.ts` asks git:

```
git ls-files --cached --others --exclude-standard -z
```

= tracked files PLUS untracked files that are not ignored. There is no list to
maintain: `node_modules/`, `.next/`, `.claude/`, `prisma/generated/` and every
future `.gitignore` entry fall out for free, and a brand-new file a contributor
has not `git add`-ed yet is still scanned — so a guard cannot go green locally on
work CI would fail.

Measured: 5,991 paths in 93 ms, cached at module scope for the process. That is
not slower than the `fs` walk it replaces, which has to stat every entry it then
discards. `tests/guardrails/no-secrets.test.ts` already shelled `git ls-files`
for exactly this reason — the pattern existed, it just had not been generalised.

The ratchet in `tests/guardrails/source-scan-population.test.ts` fails when any
file under `tests/` hands the repo root to a directory read, in either shape
(`readdirSync(ROOT)` or the `walk(ROOT)` seed). It carries **no allowlist** — an
exempted entry would be the same hand-maintained denominator the change exists
to remove.

## Files

| file | role |
| --- | --- |
| `tests/helpers/repo-files.ts` | new — `repoFiles()` / `repoRelativeFiles()` / `listGitFiles(cwd)`; the git-defined population |
| `tests/guardrails/source-scan-population.test.ts` | new — helper contract (on a throwaway repo) + the no-root-walk ratchet + its mutation proof |
| `tests/guardrails/prisma-schema-folder-coverage.test.ts` | the reported bug: `walk(REPO_ROOT)` → `repoFiles({ extensions })` |
| `tests/guards/deterministic-install.test.ts` | `readdirSync(ROOT)` → `repoRelativeFiles()` filter |
| `tests/guards/no-legacy-peer-deps.test.ts` | same |
| `jest.config.js` | `.claude/` added to `testPathIgnorePatterns` + `modulePathIgnorePatterns`, both projects |
| `eslint.config.mjs` | `.claude/**` added to `ignores` |
| `tsconfig.json` | `.claude` added to `exclude` |
| `.dockerignore` | `.claude/` added |

## Decisions

- **git, not a better skip list.** The brief's argument holds: a skip list is a
  hand-maintained denominator and nothing checks it against reality. Adding
  `.claude` to N arrays would fix today's instance and leave the mechanism that
  produced it intact.

- **The helper THROWS when git is unavailable; there is no `fs`-walk fallback.**
  A fallback would quietly restore the failure mode — a guard scanning a
  different population than the one it claims to — and would do it precisely
  when nobody is looking. Every environment that runs these tests has a work
  tree (`actions/checkout` leaves one).

- **`--cached --others --exclude-standard`, not plain `git ls-files`.** Tracked
  only would silently skip a file a contributor has written but not staged, so
  the guard would pass locally and fail on CI — a false green in the direction
  that wastes the most time.

- **The two non-recursive install-surface tests were migrated even though they
  were not broken.** Leaving them meant the ratchet needed a two-entry
  allowlist. Six lines each bought an exception-free rule.

- **The helper's contract is proved on a throwaway `git init` repo in
  `mkdtemp`, not by planting files in this one.** The first draft planted an
  untracked file at the repo root as its positive control; a *different Jest
  worker* running the prisma guardrail listed that file and then died with
  ENOENT when the plant was cleaned up mid-read. Any transient file inside the
  tree is visible to every suite running in parallel. The property under test is
  about git's rules, so it can be proved somewhere harmless.

- **The detector matches a `readdirSync(` CALL, not the string.** With an
  `includes('readdirSync')` gate the ratchet flagged `tests/helpers/repo-files.ts`
  — whose header comment names `fs.readdirSync` to explain what it replaces. The
  remedy was reported as the disease. A synthetic "prose only" case is now part
  of the mutation proof.

- **Only `tests/**` is scanned by the ratchet, and only the repo-root shape is
  flagged.** A walk rooted at `src/…` cannot reach a gitignored tree in this
  repo, so flagging every `readdirSync` would be noise with no failure behind
  it. Migrating the other ~209 walkers is available but was not done here:
  each has bespoke filtering, and the change would be a large diff with no
  behaviour to verify against.

- **`modulePathIgnorePatterns` as well as `testPathIgnorePatterns`.** The first
  stops Jest RUNNING the worktree copies; the haste map crawls independently and
  still found them, which is where `duplicate manual mock found: next-intl` came
  from. Both are needed, and `<rootDir>/`-anchoring matters: it excludes
  worktrees nested under the current root without excluding the current
  worktree's own tests — which the blanket `--testPathIgnorePatterns='/\.claude/worktrees/'`
  workaround did when run from inside a worktree.

- **CI's ratchet job overrides `--testPathIgnorePatterns` on the command line**,
  so the `jest.config.js` entries do not apply there. That is fine — the bug is
  local-only by construction. The config change removes the need for the manual
  flag on every local run.
