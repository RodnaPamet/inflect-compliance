# Shared UI: upstream-first

`playerz.bg` (RodnaPamet/projectZ) vendors a set of this repo's UI files
byte-identical and syncs them by hash. That only holds if every shared-UI fix
lands **here first** and the consumer copies it — a local edit over there is a
divergence nobody sees until the next sync fails.

This document is **advisory**. It does not gate CI, and it cannot: a check that
greps a markdown file for a path verifies mention, not accuracy
(`CLAUDE.md:1408`, and the deleted `rq3-11-capstone` ratchet is the worked
example). The guards named below are the enforcement. **If this document and a
guard ever disagree, the guard is right and this file is stale.**

## The shared paths

| root | what it holds |
|---|---|
| `src/components/ui` | the primitive library |
| `src/components/layout` | the shell, chrome and nav frame |
| `src/components/app-shell` | the frame entry point |
| `src/lib/hooks` | shared hooks |

Membership is not a list in this file. It is
`docs/_status/ui-core-classification.json`, which classifies every file under
those roots `GENERIC`, `MIXED` or `COUPLED` — and a file under a shared root
that is absent from that map is a CI failure, so the set cannot go stale
quietly.

## The constraint

A change to a file classified `GENERIC` must stay product-neutral:

1. **No domain copy.** User-visible strings go through next-intl.
2. **No compliance vocabulary** in props, comments or JSDoc — the nouns a
   second product does not share.
3. **No storage key** outside the `uiStorageKey` / `uiCookieName` seam
   (`src/lib/ui-storage.ts`). The prefix is the one constant a downstream
   product changes; a raw key is a diff it has to carry.
4. **No brand FILL token used as text.** `--brand-default` measures **4.03:1**,
   below WCAG 1.4.3's 4.5:1 — `text-content-brand` is the AA-safe token. Brand
   as a border, background or fill is fine: non-text owes 1.4.11's 3:1, which
   4.03:1 clears.
5. **No import** from `src/app-layer` or a domain module under
   `src/lib/<domain>`.

## What enforces each clause

Nothing here is enforced twice. Each clause already has an owner:

| clause | guard |
|---|---|
| 1 — domain copy | `tests/guardrails/i18n-adoption-ratchet.test.ts` — scans all of `src/components`, fails on any NEW un-localised surface |
| 2 — compliance vocabulary | recorded judgement in the classification map; the vendored subset is also checked by `tests/guards/vendored-file-wording.test.ts` |
| 3, 4, 5 | `tests/guards/ui-core-classification.test.ts` — re-derived mechanically, and a file recorded `GENERIC` that trips one fails |
| regression in a `MIXED` file | `tests/guards/shared-ui-coupling-ratchet.test.ts` — the coupled-file counts may only fall |

The last row is the gap the first three left: they police `GENERIC` files, so a
file already classified `MIXED` could acquire *more* coupling unnoticed. The
ratchet closes it from the other side — the totals can go down and not up.

## For a consumer

Keep your own manifest guard refusing local edits to vendored copies — playerz
has one. The two halves then meet: inflect refuses a product-specific change to
a shared file, and the consumer refuses a local edit to its copy.

## If you need to couple a shared file

Don't make it product-specific in place. Either lift the product-specific part
into a slot the host supplies — `AppShellFrame`'s render props and
`UserMenu`'s `items` are the worked examples, from T07 and T08 of #3003 — or
reclassify the file `COUPLED` in the map, with the reason, and accept that it
leaves the shared core.
