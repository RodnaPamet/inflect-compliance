/**
 * `direction="left"` — the edge a navigation drawer slides out of.
 *
 * A nav drawer anchored right reads as arriving from the wrong side of the
 * screen: the rail it belongs to is on the left, so the panel should appear to
 * grow out of it. T07 builds its mobile navigation on this.
 *
 * The trap worth a test is the slide-in vector. Vaul animates the panel in
 * along `--initial-transform`, and the existing code had the SAME positive
 * value on both branches of an `isSide` ternary. Copy that to a left-anchored
 * sheet and it is pinned left while animating in from the right — travelling
 * across the whole viewport. The sign has to flip.
 */

import { render } from '@testing-library/react';

import { Sheet } from '@/components/ui/sheet';

function renderSheet(direction?: 'responsive' | 'right' | 'bottom' | 'left') {
    const { baseElement } = render(
        <Sheet open size="md" title="detail" direction={direction}>
            <Sheet.Body>
                <p>body</p>
            </Sheet.Body>
        </Sheet>,
    );
    const surface = baseElement.querySelector<HTMLElement>(
        '[data-sheet-direction]',
    );
    if (!surface) throw new Error('sheet surface did not render');
    return surface;
}

describe('<Sheet direction="left" />', () => {
    it('reports the resolved direction', () => {
        expect(renderSheet('left').dataset.sheetDirection).toBe('left');
    });

    it('pins the left edge, not the right', () => {
        const className = renderSheet('left').className;

        expect(className).toContain('left-2');
        expect(className).not.toContain('right-2');
        // Still a full-height edge panel, same as the right variant.
        expect(className).toContain('top-2');
        expect(className).toContain('bottom-2');
    });

    it('slides in from the LEFT — the transform is negative', () => {
        expect(
            renderSheet('left').style.getPropertyValue('--initial-transform'),
        ).toBe('calc(-100% - 8px)');
    });

    it('is a side panel, so it carries no bottom-drawer drag handle', () => {
        // The handle is the bottom sheet's drag affordance; an edge panel has
        // nothing to drag downwards.
        const surface = renderSheet('left');
        expect(surface.className).not.toContain('inset-x-2');
    });

    it('leaves right and bottom exactly as they were', () => {
        // The regression guard for the shared `isSide` branch: widening it to
        // admit `left` must not have changed either existing direction.
        const right = renderSheet('right');
        expect(right.dataset.sheetDirection).toBe('right');
        expect(right.className).toContain('right-2');
        expect(right.style.getPropertyValue('--initial-transform')).toBe(
            'calc(100% + 8px)',
        );
    });

    it('bottom keeps its inset-x positioning and positive transform', () => {
        const bottom = renderSheet('bottom');
        expect(bottom.dataset.sheetDirection).toBe('bottom');
        expect(bottom.className).toContain('inset-x-2');
        expect(bottom.style.getPropertyValue('--initial-transform')).toBe(
            'calc(100% + 8px)',
        );
    });
});
