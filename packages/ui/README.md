# `@inflect/ui`

The shared, product-neutral UI package for #3046. **It is empty.** Step 1 of
`docs/shared-ui-package-design.md`'s Roadmap creates the shell and moves no
files; the icons arrive at step 2 and the 93 non-icon modules at step 3.

Consumed by the application as an npm workspace, at HEAD, never version-pinned
(§3). There is no build step — the package ships `.ts`/`.tsx` sources and the
consumer compiles them, because the consumer's Tailwind has to see the class
strings anyway (§4) and a `dist/` would put a stale compiled copy beside a fresh
source one.

## What may be imported from inside this package

1. Itself, by relative path.
2. The four declared `peerDependencies` — `react`, `react-dom`, `next`,
   `next-intl`. All four are singletons in a Next app, so a duplicated copy is a
   runtime fault rather than a size problem; they are peers for that reason and
   not to save bytes.
3. Regular dependencies, once there is code that needs them. §2 of the design
   doc lists the measured set (`class-variance-authority`, `clsx`,
   `tailwind-merge`, `lucide-react`, `motion`, `sonner`, `vaul`, `cmdk`,
   `@tanstack/react-table`, `react-window`, `@number-flow/react`, `date-fns`,
   `zod`, `d3-array`, the `@visx/*` six and the `@radix-ui/react-*` eight).
   **None is declared yet**, deliberately: `src/index.ts` imports nothing, and a
   dependency range declared here for code that does not exist can resolve to a
   different version than the root installed, which is the second-copy fault
   peers exist to avoid. Each one lands with the files that import it.
4. **Nothing else.** In particular no `@/app-layer`, no `@/lib/<domain>`, and no
   `@/components/<anything outside the package>`.

`tsconfig.json` is what is supposed to make clause 4 a compiler error rather
than a regex: it resets the root's `paths` and `baseUrl`, so `@/…` does not
resolve here. Note the limit of that today — the ROOT `tsconfig.json` includes
`**/*.ts`, so `npm run typecheck` compiles this tree under the root's config,
where `@/*` *does* resolve. Nothing runs `tsc -p packages/ui` yet. With an empty
`src/index.ts` a check wired now could not fail, so it is named here and belongs
with step 2, when there is a file for it to have an opinion about.

## Tokens

`tokens.contract.css` declares the 47 theme tokens this package's components
will consume, each with a fallback: a neutral literal for the 45 that §4 measured,
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
