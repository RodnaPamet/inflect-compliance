import { render, screen } from '@testing-library/react';

import {
    OverlayDepthProvider,
    useIsNestedInOverlay,
    useOverlayDepth,
} from '@/components/ui/overlay-depth';

/**
 * A POPOVER INSIDE A SHEET MUST NOT OPEN A SECOND SHEET.
 *
 * On mobile, Popover, Modal and Sheet all present as Vaul drawers. Open a
 * searchable Combobox (a Popover) inside a Modal and TWO drawers mount:
 *
 *   • the second animates up over the first, which looks broken;
 *   • two overlapping scroll locks, so the page underneath is stuck;
 *   • drag-to-dismiss dismisses the WRONG sheet;
 *   • escape closes both, or neither, depending on focus.
 *
 * `forceDropdown` was the opt-out — a flag every call site had to remember, in
 * a situation the call site often CANNOT SEE. Whether a Combobox is inside a
 * Modal depends on where the component was USED, not how it was written; a
 * shared form component has no idea.
 *
 * So the component asks the tree. These tests pin that.
 */

function DepthProbe() {
    const depth = useOverlayDepth();
    const nested = useIsNestedInOverlay();

    return (
        <div>
            <span data-depth>{depth}</span>
            <span data-nested>{String(nested)}</span>
        </div>
    );
}

const depthOf = () =>
    screen.getByText((_, el) => el?.hasAttribute('data-depth') === true)
        .textContent;
const nestedOf = () =>
    screen.getByText((_, el) => el?.hasAttribute('data-nested') === true)
        .textContent;

describe('overlay depth', () => {
    it('a component at the page root is NOT nested — it gets its bottom sheet', () => {
        // The common case. A Popover on a page should absolutely present as a
        // sheet on mobile; that is the whole point of the primitive.
        render(<DepthProbe />);

        expect(depthOf()).toBe('0');
        expect(nestedOf()).toBe('false');
    });

    it('a component INSIDE one overlay knows it is nested', () => {
        render(
            <OverlayDepthProvider>
                <DepthProbe />
            </OverlayDepthProvider>,
        );

        expect(depthOf()).toBe('1');
        expect(nestedOf()).toBe('true');
    });

    it('depth ACCUMULATES — a sheet in a modal in a sheet still knows', () => {
        // It must not merely be a boolean flag that the innermost provider
        // resets.
        render(
            <OverlayDepthProvider>
                <OverlayDepthProvider>
                    <DepthProbe />
                </OverlayDepthProvider>
            </OverlayDepthProvider>,
        );

        expect(depthOf()).toBe('2');
        expect(nestedOf()).toBe('true');
    });

    it('a sibling OUTSIDE the overlay is unaffected', () => {
        // The provider must wrap the overlay's CONTENT, not the whole page. A
        // Popover elsewhere on the page is not nested and must still get its
        // sheet.
        render(
            <>
                <OverlayDepthProvider>
                    <span data-inside>nested</span>
                </OverlayDepthProvider>
                <DepthProbe />
            </>,
        );

        expect(depthOf()).toBe('0');
        expect(nestedOf()).toBe('false');
    });
});
