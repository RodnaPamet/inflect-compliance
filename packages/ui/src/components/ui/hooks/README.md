# UI utility hooks

Epic 60's canonical home for **shared, reusable React hooks** that
belong to the UI layer — viewport awareness, scroll behaviour,
persistence, optimistic state, keyboard-friendly input, and other
polish primitives that enterprise workflows benefit from.

## Where hooks live

| Directory | Purpose | Example |
|---|---|---|
| `src/components/ui/hooks/` | Shared **UI utility** hooks. No data fetching, no server-only code. | `useLocalStorage`, `useScroll`, `useMediaQuery` |
| `src/lib/hooks/` | Typed **domain** + data-fetching hooks (React-Query-shaped). Also the home of cross-cutting platform hooks like `useKeyboardShortcut` and `useApi`. | `useControls`, `useRisks`, `useKeyboardShortcut` |
| Feature-local — e.g. `src/components/ui/table/use-table-pagination.tsx`, `src/components/ui/charts/use-tooltip.ts`, `src/components/ui/filter/use-filter-presets.ts` | Hooks tightly coupled to a specific primitive. Stay with the feature they serve. | — |

The rule: **a new UI utility hook goes here unless it's clearly
owned by a specific feature module**. If you find yourself copying a
viewport / scroll / persistence hook into two different places, it
belongs here.

## Categories (Epic 60 scope)

| Category | Purpose | Current inhabitants |
|---|---|---|
| Persistence | Browser-local state survival across reloads | `useLocalStorage` |
| Viewport / observer | Reading / reacting to element geometry and media queries | `useInViewport`, `useIntersectionObserver`, `useResizeObserver`, `useMediaQuery`, `useResponsivePresentation` |
| Scroll | Reading / reacting to scroll position and progress | `useScroll`, `useScrollProgress` |
| Optimistic UI | Framework-agnostic local overlay on a committed value, with rollback on failure | `useOptimisticUpdate` |
| Submit / input / keyboard | Form-friendly keyboard behaviour: Enter-to-submit with multiline/IME safety (`useEnterSubmit`), editable-focus signal mirroring Epic 57 (`useInputFocused`), shortcut registration via the shared Epic 57 registry (`useKeyboardShortcut` shim) | `useEnterSubmit`, `useInputFocused`, `useKeyboardShortcut` |
| Dense-table ergonomics | Table-state utilities broad enough to escape the table module | `useColumnVisibility` |
| Clipboard / copy | Clipboard writing with success/failure state | `useCopyToClipboard` |

## Conventions

### Naming

- **File name:** `use-kebab-case.ts` (or `.tsx` if the hook renders JSX,
  e.g. returns a Provider component as part of its API).
- **Default export:** none. Named exports only, so the barrel can
  tree-shake.
- **Hook name:** `useCamelCase` matching the file slug. One primary
  hook per file. If the file exports multiple helpers, keep the hook
  first in the file.
- **Type exports:** `UseXxxOptions`, `UseXxxResult` — pair the hook
  name as a prefix, export both via the barrel so callers can type
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
3. Add the export line to `./index.ts` **under the right category
   comment**. Categories keep the barrel readable as the set grows.
4. If the hook needs a browser guard, follow the SSR-safety pattern
   above — see `use-local-storage.ts` and `use-media-query.ts` for
   reference implementations.
5. Add a `tests/rendered/` render test covering the happy path, the
   SSR/hydration boundary, and cleanup.

`tests/guards/ui-hooks-barrel.test.ts` enforces barrel completeness —
a hook file without a barrel export fails CI.

## Importing

```ts
// ✅ always import from the barrel
import { useLocalStorage, useScroll } from '@/components/ui/hooks';

// ❌ avoid deep-path imports — implementation detail
import { useLocalStorage } from '@/components/ui/hooks/use-local-storage';
```

The deep path still works (file-level exports are public), but the
barrel is the contract. Deep-path imports bypass the barrel-audit
guard, so they stay invisible to the "what's in this module" check.

## Related

- `@/lib/hooks` — domain + data-fetching hooks (`useApi`, `useControls`,
  `useRisks`, ...). Different module, different responsibility.
- `docs/implementation-notes/2026-04-22-epic-60-hooks-foundation.md` —
  design rationale for why this directory exists as a separate home
  from `src/lib/hooks/`.
