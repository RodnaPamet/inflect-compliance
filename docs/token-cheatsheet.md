# Token Cheatsheet

Epic 51 — Design Token & Theme System.

Quick-reference mapping from raw Tailwind color classes → semantic tokens.
Everything token-backed re-themes automatically when the user flips to light mode.

For the full rationale, see `src/styles/tokens.css`.

---

## Surfaces

| Raw class | Semantic token class | CSS variable |
| --- | --- | --- |
| `bg-slate-900` | `bg-bg-page` | `--bg-page` |
| `bg-slate-800` | `bg-bg-default` | `--bg-default` |
| `bg-slate-700` (elevated surface) | `bg-bg-elevated` | `--bg-elevated` |
| `bg-slate-700/30` (hover / pressed) | `bg-bg-muted` | `--bg-muted` |
| `bg-slate-100` (inverted) | `bg-bg-inverted` | `--bg-inverted` |
| `bg-black/60` (modal backdrop) | `bg-bg-overlay` | `--bg-overlay` |
| `bg-slate-700/30` (selection / disabled tint) | `bg-bg-subtle` | `--bg-subtle` |
| (shaded band / boxed list row) | `bg-bg-shaded` | `--bg-shaded` |

`--bg-shaded` is warm grey in light and a cool blue tint in dark (owner choice,
2026-11-22). It is the detail-page tab bar's band and every boxed list row's
box, always with `border-border-strong`: use `<ShadedRow>` (below) rather than
writing the classes.

## Content / text

| Raw class | Semantic token class |
| --- | --- |
| `text-white` / `text-slate-100` | `text-content-emphasis` |
| `text-slate-300` | `text-content-default` |
| `text-slate-400` | `text-content-muted` |
| `text-slate-500` | `text-content-subtle` |
| `text-slate-900` (on light surfaces) | `text-content-inverted` |

## Borders

| Raw class | Semantic token class |
| --- | --- |
| `border-slate-700` | `border-border-default` |
| `border-slate-700/50` | `border-border-subtle` |
| `border-slate-600` | `border-border-emphasis` |

## Status colors (already token-backed in most places)

| Raw class | Semantic token class |
| --- | --- |
| `bg-emerald-500/15`, `text-emerald-400`, `border-emerald-500/30` | `bg-bg-success` / `text-content-success` / `border-border-success` |
| `bg-amber-500/15`, `text-amber-400`, `border-amber-500/30` | `bg-bg-warning` / `text-content-warning` / `border-border-warning` |
| `bg-red-500/15`, `text-red-400`, `border-red-500/30` | `bg-bg-error` / `text-content-error` / `border-border-error` |
| `bg-blue-500/15`, `text-blue-400`, `border-blue-500/30` | `bg-bg-info` / `text-content-info` / `border-border-info` |
| `bg-amber-400/15`, `text-amber-400`, `border-amber-400/30` | `bg-bg-attention` / `text-content-attention` / `border-border-attention` |

## Focus ring

| Raw class | Semantic |
| --- | --- |
| `focus-visible:ring-brand-500 ring-offset-slate-900` | `focus-visible:ring-ring ring-offset-background` |

---

## Components, not classes

For these patterns, migrate to the component — not to semantic-class equivalents:

| Legacy CSS | Component |
| --- | --- |
| `<button className="btn btn-primary">` | `<Button variant="primary">` from `@/components/ui/button` |
| `<button className="btn btn-secondary">` | `<Button variant="secondary">` |
| `<button className="btn btn-danger">` | `<Button variant="danger">` |
| `<span className="badge badge-success">` | `<Badge variant="success">` from `@/components/ui/badge`, or `<StatusBadge variant="success">` for badges with an icon / tooltip |
| `<span className="badge badge-neutral">` | `<Badge variant="neutral">` (default) |
| `<li className="rounded-lg border border-border-subtle p-3">` (one of a card's boxed rows) | `<ShadedRow as="li">` from `@/components/ui/shaded-row` — the shade and strong outline, `padding` `sm`/`md` (default)/`lg`/`xl`/`none`. A row carrying a state tone keeps its own classes. Lint: `local/shaded-list-rows` |

The component layer carries:
- Token-backed surface + text + border (so light mode works)
- CVA-driven size variants
- `disabledTooltip`, `loading`, `icon`, `shortcut` slots on Button
- Built-in icon + `tooltip` slot on StatusBadge

Prefer the component over hand-built classes — it's the only way to keep the app's buttons and chips visually consistent across themes.

---

## Theming rules

1. **Every new token added to `:root` needs a `[data-theme="light"]` override** if it changes between themes (surfaces, content, borders, status colors, glass, shadows). The guardrail at `tests/guardrails/light-mode-parity.test.ts` enforces this.
2. **Never hardcode `slate-*`, `gray-*`, `neutral-*`, `zinc-*`** in new code under `src/app/**/*.tsx`. The ratchet at `tests/guardrails/raw-color-ratchet.test.ts` caps the count and can only go down.
3. **Print-only views and unauthenticated routes** (login, global error pages, audit-share) are allowlisted in the ratchet's comment — they still use raw colors because tokens don't apply under `@media print` or before the `<ThemeProvider>` mounts.
4. **Every new page added to `MIGRATED_PAGES`** in `tests/guardrails/design-system-drift.test.ts` gets strict drift protection — a re-introduction of raw colors in that file will fail CI.

---

## Verifying theme work

```bash
# Every Epic 51 guardrail
npx jest --selectProjects node \
  tests/guardrails/design-system-drift.test.ts \
  tests/guardrails/light-mode-parity.test.ts \
  tests/guardrails/raw-color-ratchet.test.ts \
  tests/unit/theme-provider.test.ts

# Light-mode E2E smoke
npx playwright test tests/e2e/theme-toggle.spec.ts
```

## When to refuse the migration

Not every `bg-slate-800` needs to move:

- **Print stylesheets** (`@media print`, PDF snapshots, `SoAPrintView.tsx`) — tokens aren't applied under print rules; hardcoded colors are the right answer.
- **Global error boundaries** (`error.tsx`, `not-found.tsx`) — they render before the `ThemeProvider` tree is guaranteed to mount.
- **Unauthenticated routes** (`/login`, `/audit/shared/[token]`) — outside the tenant context, no theme provider is in scope yet.

For everything else, reach for the semantic token.
