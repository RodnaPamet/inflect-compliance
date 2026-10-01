"use client";

import { createContext, useContext, type PropsWithChildren } from "react";

/**
 * AM I ALREADY INSIDE A BOTTOM SHEET?
 *
 * ═══ The bug this exists to make impossible ═══
 *
 * On mobile, `<Popover>` presents itself as a Vaul drawer — a bottom sheet. So
 * does `<Modal>`, and so does `<Sheet>`.
 *
 * Now open a searchable `<Combobox>` (which is a Popover) inside a `<Modal>`.
 * Two drawers mount, one on top of the other. What the user gets is:
 *
 *   • the second sheet animating up over the first, which looks broken;
 *   • two overlapping scroll locks, so the page underneath is stuck;
 *   • a drag-to-dismiss gesture that dismisses the WRONG sheet;
 *   • an escape key that closes both, or neither, depending on focus order.
 *
 * The existing fix is `forceDropdown` — a prop each call site passes to say "I
 * am inside a sheet, present as a popover instead". There are 95 of them in
 * this codebase.
 *
 * THAT IS THE WRONG SHAPE FOR A FIX. It is an opt-out that every future call
 * site must remember, in a situation the call site often cannot even see:
 * whether a Combobox is inside a Modal depends on where the component was
 * *used*, not on how it was *written*. A shared form component has no idea.
 *
 * So the component asks the tree instead. Any overlay that mounts as a drawer
 * declares it; a Popover nested inside one sees that and presents as a popover
 * automatically. `forceDropdown` remains as an explicit override, and the 95
 * existing sites simply become redundant.
 *
 * The failure mode flips from "you forgot a flag and it is broken" to "it is
 * right by default, and you can override it".
 */

const OverlayDepthContext = createContext(0);

/**
 * Wrap the CONTENT of any overlay that mounts as a drawer.
 *
 * Not the trigger — the content. The depth must only apply to what is rendered
 * INSIDE the sheet; a Popover elsewhere on the page is not nested and must
 * still get its bottom sheet.
 */
export function OverlayDepthProvider({ children }: PropsWithChildren) {
    const depth = useContext(OverlayDepthContext);

    return (
        <OverlayDepthContext.Provider value={depth + 1}>
            {children}
        </OverlayDepthContext.Provider>
    );
}

/** How many drawers deep are we? 0 at the page root. */
export function useOverlayDepth(): number {
    return useContext(OverlayDepthContext);
}

/**
 * Should this overlay present as a plain popover rather than a bottom sheet?
 *
 * True when we are already inside one. Stacking sheets is the bug.
 */
export function useIsNestedInOverlay(): boolean {
    return useContext(OverlayDepthContext) > 0;
}
