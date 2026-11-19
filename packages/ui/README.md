# `@inflect/ui`

The shared, product-neutral UI package for #3046. It holds:

| Path under `src/` | What |
|---|---|
| `components/ui/*.tsx`, `*-variants.ts` | Primitives: `button`, `card`, `empty-state`, `error-state`, `skeleton`, `tooltip`, `typography`, and the variant tables and hit-area helper they use |
| `components/ui/charts/` | The visx chart platform: the time-series host, area and bar renderers, axes, tooltips and hover sync, gradients, motion, layout maths and the chart contracts |
| `components/ui/hooks/` | UI utility hooks: viewport and observers, scroll, persistence, optimistic state, keyboard-friendly input, clipboard, toasts (see its `README.md`) |
| `components/ui/icons/` | The icon set, including the Nucleo barrel |
| `lib/` | `cn`, `format-date`, `number-format` |

Consumed by the application as an npm workspace, at HEAD, never version-pinned
(§3). There is no build step — the package ships `.ts`/`.tsx` sources and the
consumer compiles them, because the consumer's Tailwind has to see the class
strings anyway (§4) and a `dist/` would put a stale compiled copy beside a fresh
source one.

## Importing it

Import each module by its subpath; the `exports` map in `package.json` resolves
it to a file under `src/`:

```ts
import { cn } from '@inflect/ui/lib/cn';
import { Button } from '@inflect/ui/components/ui/button';
import { useMediaQuery } from '@inflect/ui/components/ui/hooks/use-media-query';
```

The package root, `src/index.ts`, exports nothing on purpose: a root barrel
would load every module for any one of them. Its comment says why it still
holds `export {}`.

## What may be imported from inside this package

1. Itself, by relative path or by its own `@inflect/ui/…` subpaths.
2. The four declared `peerDependencies` — `react`, `react-dom`, `next`,
   `next-intl`. All four are singletons in a Next app, so a duplicated copy is a
   runtime fault rather than a size problem; they are peers for that reason and
   not to save bytes.
3. The packages in `dependencies` (and, for a test file, `devDependencies`).
   `package.json` declares every package the sources import, each with the
   root's specifier unchanged, so npm resolves it to the root's single copy
   rather than installing a second one beside it.
   `tests/guards/ui-package-declares-what-it-imports.test.ts` parses every file
   under `src/` and fails on an import the manifest does not declare, an entry
   nothing imports, a range that differs from the root's, or a nested copy in
   the lockfile. A new import lands with its manifest entry, in this file and
   at the root.
4. **Nothing else.** In particular no `@/app-layer`, no `@/lib/<domain>`, and no
   `@/components/<anything outside the package>`.

## Type checking

`tsconfig.json` makes clause 4 a compiler error rather than a regex: it resets
the root's `paths` and `baseUrl`, so `@/…` does not resolve here. CI compiles
the package through it in its own step, `npm run typecheck:ui-boundary`
(`tsc --noEmit -p packages/ui/tsconfig.json`). The root `npm run typecheck`
also compiles this tree, but under the root's config, where `@/*` resolves —
which is why the separate step exists.

The same file turns on `noUncheckedIndexedAccess`, which the root does not: an
index read here has to prove the element exists, so a product that mirrors the
package and compiles with that flag can keep it on. The guard above fails if
the flag is removed.

## Tokens

`tokens.contract.css` declares the 47 theme tokens this package's components
consume, each with a fallback: a neutral literal for the 45 that §4 measured,
and an alias of the brand for `--accent-default` / `--accent-emphasis`, the colour
the solid focus indicators are drawn in (a host that focuses in its brand needs
to do nothing). The package requires tokens, does not ship them, and ships their
names — the host's real palette lives in `src/styles/tokens.css` and stays there
(§4). A consumer is expected to override all 47.

The Tailwind config is **not** part of the package: it stays with the
application, and what a consumer must merge into its own `theme.extend.colors`
is documented in §4 rather than enforced, because neither repo can see the
other's config at build time. That is a known hole, named rather than papered
over.

## Reading order

`docs/shared-ui-package-design.md` — §1 what is in the package, §2 the boundary,
§3 how it is consumed, §4 tokens and CSS, §5 what breaks, Roadmap (§6) the step
order.
