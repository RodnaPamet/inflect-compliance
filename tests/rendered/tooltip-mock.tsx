/**
 * Tooltip DELEGATE for the jsdom test project — not a stub (#3163).
 *
 * `jest.config.js` maps the RELATIVE tooltip import (`./tooltip`,
 * `../tooltip`) here, because 18 files under `src/components/ui/` reach the
 * primitive that way and 8 of them instantiate `<Tooltip content={…}>`
 * unconditionally — `copy-text`, `copy-button`, the modal and sheet close
 * buttons, the date-picker calendar and presets, `filter-range-panel`,
 * `selection-toolbar`. `src/components/ui/tooltip.tsx` does NOT self-provide,
 * and Radix throws `` `Tooltip` must be used within `TooltipProvider` `` — so
 * what the mapping is load-bearing for is the PROVIDER, not the pass-through.
 * Of 354 jsdom suites, 67 import `TooltipProvider`; the rest mount none.
 *
 * ## Why this delegates instead of passing through
 *
 * Until #3163 these exports rendered `<>{children}</>`. That made tooltip
 * behaviour UNOBSERVABLE from any page test whose component spelled the
 * import relatively: #3159 moved three digest displays on the parameter-sets
 * page behind `<CopyText>` (which imports `./tooltip`) and two working
 * `findByRole('tooltip')` assertions died with it. The mapping is keyed on how
 * a module is SPELLED, so two components using the same primitive got
 * different test environments — invisible at the call site.
 *
 * Scoping the mapping per-suite was measured and rejected: it inverts into
 * opting ~200 suites into a provider. So instead each export below renders the
 * REAL primitive and supplies the provider the suite did not mount. Zero
 * per-suite change, because `TooltipProvider` emits no DOM of its own and
 * Radix unmounts closed content — a CLOSED tooltip's DOM is byte-identical to
 * the pass-through's.
 *
 * ## Why there is no recursion
 *
 * The import below is spelled `@/components/ui/tooltip`. `moduleNameMapper`'s
 * `^@/(.*)$` entry comes FIRST and claims it, and neither `^\./tooltip$` nor
 * `^\.\./tooltip$` can ever match an `@/`-prefixed request. So this file
 * resolves the real module while every relative importer still lands here.
 * Do NOT change this import to a relative path — that is the recursion.
 *
 * ## Why every delegate can fall back to a pass-through
 *
 * `@/components/ui/tooltip` is SHARED ANCESTRY: twelve jsdom suites replace
 * that barrel with their own `jest.mock(…)` factory — because Radix's provider
 * spins timers that never settle under fake timers — and every one of those
 * factories is PARTIAL. Measured: all 12 omit `DynamicTooltipWrapper`, and
 * `org-sidebar-nucleo-icons` + `reports-client` also omit `TooltipProvider`
 * and `InfoTooltip`. Inside such a suite this file resolves THEIR module, so
 * delegating blindly renders `undefined` and React throws `Element type is
 * invalid … Check the render method of ForwardRef(DynamicTooltipWrapper)`.
 * That is not hypothetical: it failed 8 tests in
 * `auditor-revoke-safeguards.test.tsx` before this fallback existed.
 *
 * So each delegate degrades to a pass-through when the name it needs is absent
 * — which is exactly what a suite that mocked the barrel away asked for.
 *
 * The fallback cannot hide a real removal from `src/components/ui/tooltip.tsx`:
 * the named imports below are type-checked, so a deleted export fails `tsc`,
 * and `tests/rendered/tooltip.test.tsx` imports all four by name through the
 * `@/` alias and exercises them. The fallback therefore only ever fires at
 * RUNTIME, under a suite-local `jest.mock`.
 *
 * ## Why delayDuration={0}
 *
 * Radix opens on FOCUS with no delay regardless (`onOpen`, not
 * `handleDelayedOpen`), so the keyboard path does not need this. Pointer-enter
 * does, and 0 is already the convention in the suites that mount a provider
 * themselves — `tooltip.test.tsx`'s `Harness` and
 * `parameter-sets-surface.test.tsx`'s `mount`. Note that Radix providers
 * nest by overriding: a suite that mounts its own provider has this one
 * INSIDE it, so this delay wins for tooltips reached through a relative
 * import. That is deliberate — a test should not have to wait out a 1s timer.
 *
 * The real primitive gates focus-open on `matches(':focus-visible')`; see
 * `tests/rendered/parameter-sets-surface.test.tsx` for the nwsapi version
 * window that gate is only safe inside.
 */

import * as React from 'react';
import * as tooltipModule from '@/components/ui/tooltip';

/**
 * The module as it is at RUNTIME, which a suite-local `jest.mock` may have
 * left incomplete. `Partial` is the honest type for that — see "Why every
 * delegate can fall back" above. Read through this, never through a direct
 * named binding, so a missing export is a value to branch on rather than an
 * `undefined` React element type.
 */
const mod: Partial<typeof tooltipModule> = tooltipModule;

/** What a mocked-away tooltip should render: its trigger, and nothing else. */
function PassThrough({ children }: { children?: React.ReactNode }) {
    return <>{children}</>;
}

/**
 * The provider the suite under test did not mount. Rendered per tooltip
 * rather than once, because there is no mount point a module mock can reach.
 */
function AutoProvider({ children }: { children: React.ReactNode }) {
    const Provider = mod.TooltipProvider;
    if (!Provider) return <>{children}</>;
    return (
        <Provider delayDuration={0} skipDelayDuration={0}>
            {children}
        </Provider>
    );
}

export const TooltipProvider = mod.TooltipProvider ?? PassThrough;

export const Tooltip = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof tooltipModule.Tooltip>
>(function Tooltip(props, ref) {
    const Real = mod.Tooltip;
    if (!Real) return <>{props.children}</>;
    return (
        <AutoProvider>
            <Real ref={ref} {...props} />
        </AutoProvider>
    );
});

export const InfoTooltip = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof tooltipModule.InfoTooltip>
>(function InfoTooltip(props, ref) {
    const Real = mod.InfoTooltip;
    // No children to pass through: a mocked-away InfoTooltip renders nothing,
    // which is what the two suites that omit it already spell as `() => null`.
    if (!Real) return null;
    return (
        <AutoProvider>
            <Real ref={ref} {...props} />
        </AutoProvider>
    );
});

export const DynamicTooltipWrapper = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof tooltipModule.DynamicTooltipWrapper>
>(function DynamicTooltipWrapper(props, ref) {
    const Real = mod.DynamicTooltipWrapper;
    if (!Real) return <>{props.children}</>;
    return (
        <AutoProvider>
            <Real ref={ref} {...props} />
        </AutoProvider>
    );
});
