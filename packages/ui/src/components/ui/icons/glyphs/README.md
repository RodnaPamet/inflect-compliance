# Glyphs

The product's general-purpose icons, under the names its call sites use
(`Plus`, `Xmark`, `Sparkle3`, `ShieldCheck`, ...). Each module wraps one
[lucide-react](https://lucide.dev) icon (ISC licence, already a dependency)
and renders it at **18px** by default, the size the set has always used. At
18px lucide's stroke of 2 on a 24-unit grid draws 1.5px, so the weight matches
too. A caller's `className`, `width` or `height` overrides the default.

```tsx
import { Plus } from "@inflect/ui/components/ui/icons/glyphs";
```

Import by name, never `import *`: the barrel is listed in
`optimizePackageImports` (`next.config.js`) so an unused glyph never reaches a
page chunk, and `tests/guards/icon-import-discipline.test.ts` holds the form.

## Where the icons come from

Only from a permissively licensed set that may be published in a public
repository. This directory replaced the Nucleo set in #5772: Nucleo's licence
prohibits redistributing its icons, and this repository is public.
`tests/guards/no-nucleo-icon-set.test.ts` keeps it out.

## Adding a glyph

Prefer importing the lucide icon directly where no local name exists yet. Add
a module here only for a name several surfaces share: one file per glyph,
named for the export in kebab case, re-exported from `index.ts`, and classified
in `docs/_status/ui-core-classification.json`.
