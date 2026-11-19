# 2026-11-19 — `@inflect/ui` stands alone for a mirroring product

**Commits:** `c43ffe6`, `9fa0685`, `1a20534`, `845289b` (Islestone #7, items 1–4)

## Design

Islestone mirrors `packages/ui` byte for byte, so anything the package leaves to
its host here — a dependency the root declares, a compiler flag the root does not
set, prose that names this product — becomes a gap there. Four changes close the
ones Islestone listed:

1. **Dependencies.** `packages/ui/package.json` declares every package the
   sources import (21 `dependencies`, 4 `devDependencies`, the 4 existing peers).
   Each entry is the root's specifier, character for character, so npm resolves
   it to the root's single copy; the lockfile change is the workspace node's
   dependency list and nothing else.
2. **`noUncheckedIndexedAccess`.** Six files had 24 unchecked index reads; each
   is now guarded with the behaviour unchanged, and `packages/ui/tsconfig.json`
   turns the flag on, so CI's `typecheck:ui-boundary` step holds it. The root
   config is untouched.
3. **Stale text.** `src/index.ts`, the README, the hooks README and the
   `description` say what the package holds and how it is imported (by subpath).
4. **Wording.** Chart comments and examples are product-neutral; eight chart
   files move from MIXED to GENERIC in `docs/_status/ui-core-classification.json`.

## Files

| File | Role |
|---|---|
| `packages/ui/package.json`, `package-lock.json` | Declared dependencies |
| `packages/ui/tsconfig.json` | `noUncheckedIndexedAccess: true` |
| `packages/ui/src/components/ui/charts/{layout,interaction,time-series-chart,use-tooltip}.ts(x)`, `hooks/{use-column-visibility,use-in-viewport}` | Guarded index reads |
| `packages/ui/README.md`, `src/index.ts`, `src/components/ui/hooks/README.md` | Accurate text |
| `packages/ui/src/components/ui/charts/*` | Neutral comments and examples |
| `tests/guards/ui-package-declares-what-it-imports.test.ts` | Manifest ↔ sources ↔ root, lockfile, tsconfig flag |
| `tests/guards/vendored-file-wording.test.ts` | Vocabulary scan extended to all of `packages/ui` |

## Decisions

- **The root's specifier, not the locked version.** The existing `clsx` entry
  already copied the root's `^2.1.0`. A caret range satisfied by the root's
  locked copy dedupes here and in a mirroring product whose root pins exact
  versions taken at an older commit; an exact pin in the workspace would install
  a second copy in either the moment the two drifted. The guard holds the
  specifiers equal, so a root major bump that forgets the workspace fails CI.
- **Peers unchanged.** `react`, `react-dom`, `next`, `next-intl` are the
  singletons; Radix, visx, motion and the rest are ordinary dependencies, as §2
  of the design doc measured them.
- **`devDependencies` hold the co-located test's `@testing-library/react` and the
  type packages** the package needs to type-check on its own (`@types/react`,
  `@types/canvas-confetti`, `@types/d3-array`). `@types/jest` is not declared:
  the test runner belongs to the host.
- **No root barrel.** Every consumer imports by subpath; a barrel would load the
  chart stack for anyone who wanted `cn`.
- **`useColumnVisibility`** now writes `false` for a key the caller passes with
  the value `undefined`, where it used to write `undefined`. That input is
  outside `ColumnVisibilityState` (`Record<string, boolean>`), so no well-typed
  caller sees the difference.
- **The vocabulary guard scans the whole package**, derived from git, because the
  mirror takes every file. It catches projectZ's plural nouns only; the singular
  wording this change removed (`risk-donut`, `Control coverage`) is held by the
  classification map's judgement, not by a regex.
