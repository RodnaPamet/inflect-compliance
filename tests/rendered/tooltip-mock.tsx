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
import {
    DynamicTooltipWrapper as RealDynamicTooltipWrapper,
    InfoTooltip as RealInfoTooltip,
    Tooltip as RealTooltip,
    TooltipProvider as RealTooltipProvider,
} from '@/components/ui/tooltip';

/**
 * The provider the suite under test did not mount. Rendered per tooltip
 * rather than once, because there is no mount point a module mock can reach.
 */
function AutoProvider({ children }: { children: React.ReactNode }) {
    return (
        <RealTooltipProvider delayDuration={0} skipDelayDuration={0}>
            {children}
        </RealTooltipProvider>
    );
}

export const TooltipProvider = RealTooltipProvider;

export const Tooltip = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof RealTooltip>
>(function Tooltip(props, ref) {
    return (
        <AutoProvider>
            <RealTooltip ref={ref} {...props} />
        </AutoProvider>
    );
});

export const InfoTooltip = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof RealInfoTooltip>
>(function InfoTooltip(props, ref) {
    return (
        <AutoProvider>
            <RealInfoTooltip ref={ref} {...props} />
        </AutoProvider>
    );
});

export const DynamicTooltipWrapper = React.forwardRef<
    HTMLButtonElement,
    React.ComponentPropsWithoutRef<typeof RealDynamicTooltipWrapper>
>(function DynamicTooltipWrapper(props, ref) {
    return (
        <AutoProvider>
            <RealDynamicTooltipWrapper ref={ref} {...props} />
        </AutoProvider>
    );
});
