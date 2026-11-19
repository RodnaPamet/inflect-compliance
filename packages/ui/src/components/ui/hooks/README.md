# UI utility hooks

The package's home for **shared, reusable React hooks** that belong to
the UI layer — viewport awareness, scroll behaviour, persistence,
optimistic state, keyboard-friendly input, and other polish primitives
that dense product screens benefit from.

## Where hooks live

| Directory | Purpose | Example |
|---|---|---|
| `packages/ui/src/components/ui/hooks/` (this directory) | Shared **UI utility** hooks. No data fetching, no server-only code, no product vocabulary. | `useLocalStorage`, `useScroll`, `useMediaQuery` |
| The host application's own hooks directories | Data-fetching and **domain** hooks, and UI hooks that reach for something the package does not hold. They import from here; nothing here imports from them. | `useItems`, `useKeyboardShortcut` |
| Feature-local — next to the primitive they serve (in this package, `charts/use-tooltip.ts` and `charts/use-heat-scale.ts`) | Hooks tightly coupled to one primitive. Stay with the feature they serve. | — |

The rule: **a new UI utility hook goes here unless it's clearly
owned by a specific feature module** and unless it needs something
outside the package's boundary (see the package `README.md`, "What may
be imported from inside this package"). If you find yourself copying a
viewport / scroll / persistence hook into two different places, it
belongs here.

## Categories

| Category | Purpose | Current inhabitants |
|---|---|---|
| Persistence | Browser-local state survival across reloads | `useLocalStorage` |
| Viewport / observer | Reading / reacting to element geometry and media queries | `useInViewport`, `useIntersectionObserver`, `useResizeObserver`, `useMediaQuery`, `useIsBelowMd`, `useResponsivePresentation` |
| Scroll | Reading / reacting to scroll position and progress | `useScroll`, `useScrollProgress` |
| Optimistic UI and saving | Framework-agnostic local overlay on a committed value, with rollback on failure; debounced field autosave | `useOptimisticUpdate`, `useAutosaveFields` |
| Submit / input / keyboard | Form-friendly keyboard behaviour: Enter-to-submit with multiline/IME safety, and an editable-focus signal for gating page-level shortcuts | `useEnterSubmit`, `useInputFocused` |
| Lists and dense tables | Table-state and list-loading utilities broad enough to escape the table module | `useColumnVisibility`, `useCursorPagination`, `useThresholdLoadMore`, `useSsrFallback`, `useCreateQueryParam` |
| Clipboard / copy | Clipboard writing with success/failure state | `useCopyToClipboard` |
| Feedback | Toasts and celebration effects | `useToast`, `useCelebration` |

## Conventions

### Naming

- **File name:** `use-kebab-case.ts` (or `.tsx` if the hook renders JSX,
  e.g. returns a Provider component as part of its API).
- **Default export:** none. Named exports only, so a host barrel can
  tree-shake.
- **Hook name:** `useCamelCase` matching the file slug. One primary
  hook per file. If the file exports multiple helpers, keep the hook
  first in the file.
- **Type exports:** `UseXxxOptions`, `UseXxxResult` — pair the hook
  name as a prefix, and export both so callers can type
  their handler signatures.

### SSR / client-only safety

These hooks run in **client components only** — the React hook rules
(`useEffect`, `useState`) make that automatic. You do NOT need a
`'use client'` directive at the top of a hook file; the consuming
component carries it.

However, hooks that touch browser globals (`window`, `document`,
`localStorage`, `matchMedia`, `IntersectionObserver`, `ResizeObserver`)
must guard the first read so they don't crash during SSR:

```ts
// ❌ crashes on the server
const value = localStorage.getItem(key);

// ✅ safe — reads defer until the effect runs client-side
useEffect(() => {
    if (typeof window === 'undefined') return;
    setValue(localStorage.getItem(key));
}, [key]);
```

State initialisers that read browser APIs must return a stable SSR
fallback so the hydrated client render matches the server render:

```ts
// ✅ server sees `null`, client hydrates, then the effect writes the
//    real value. No hydration-mismatch warning.
const [value, setValue] = useState<string | null>(null);
useEffect(() => {
    setValue(localStorage.getItem(key));
}, [key]);
```

### Cleanup

Every subscription must return a cleanup from its effect. Resize
observers, intersection observers, `addEventListener`, `setInterval`,
`ResizeObserver.observe` — all of them.

```ts
useEffect(() => {
    const handler = (e: KeyboardEvent) => { /* ... */ };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
}, [dep]);
```

Async callbacks need mount-guarded state writes so a late resolve
against an unmounted component doesn't leak a React warning:

```ts
useEffect(() => {
    let cancelled = false;
    load().then((data) => {
        if (cancelled) return;
        setState(data);
    });
    return () => { cancelled = true; };
}, [deps]);
```

### Public surface

Export the hook AND any caller-facing types (options, result shape,
callback signatures). Callers often want to type the handler they
pass in; requiring them to re-declare the shape creates drift.

## Adding a hook

1. Create `use-new-thing.ts(x)` in this directory.
2. Export the hook as a named export plus any public types.
3. If the host application keeps a hooks barrel, add the export line
   to it **under the right category comment**. Categories keep the
   barrel readable as the set grows.
4. If the hook needs a browser guard, follow the SSR-safety pattern
   above — see `use-local-storage.ts` and `use-media-query.ts` for
   reference implementations.
5. Add a render test covering the happy path, the SSR/hydration
   boundary, and cleanup — co-located under `__tests__/`, or in the
   host's rendered-test suite.
6. A package the hook imports must be declared in the package's
   `package.json` (see the package `README.md`).

In inflect-compliance, the barrel is `src/components/ui/hooks/index.ts`
and `tests/guards/ui-hooks-barrel.test.ts` enforces its completeness —
a hook file in this directory without a barrel export fails CI.

## Importing

```ts
// ✅ by the package subpath — always resolves, in any host
import { useLocalStorage } from '@inflect/ui/components/ui/hooks/use-local-storage';
import { useScroll } from '@inflect/ui/components/ui/hooks/use-scroll';
```

A host may re-export these from a barrel of its own so its call
sites import one path; inflect-compliance does
(`@/components/ui/hooks`), and its pages import from that barrel. The
package itself has no hooks barrel: inside the package, import a hook
by relative path (`./use-local-storage`) or by its subpath.

## Related

- The package `README.md` — what the package holds, how it is
  imported, and its dependency boundary.
- `docs/implementation-notes/2026-04-22-epic-60-hooks-foundation.md`
  (inflect-compliance) — design rationale for keeping UI utility hooks
  apart from data-fetching hooks.
