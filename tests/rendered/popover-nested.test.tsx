import { render, screen } from '@testing-library/react';

import { OverlayDepthProvider } from '@/components/ui/overlay-depth';
import { Popover } from '@/components/ui/popover';

/**
 * THE INTEGRATION, not just the context.
 *
 * overlay-depth.test.tsx proves the context accumulates. This proves the
 * POPOVER actually reads it — that a Popover nested inside a sheet does NOT
 * mount a second drawer.
 *
 * Testing the context alone would leave the real bug perfectly intact: the
 * provider could work flawlessly while Popover ignored it.
 */

// Force the mobile presentation. jsdom's matchMedia returns `matches: false`
// for every query, which useMediaQuery already reads as "mobile" — but pinning
// it means this suite cannot start passing for the wrong reason if that
// polyfill changes. Mocked at the LEAF module so the barrel's re-export picks
// the stub up without pulling the whole barrel through requireActual.
jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({
        device: 'mobile' as const,
        width: 375,
        height: 851,
        isMobile: true,
        isTablet: false,
        isDesktop: false,
    }),
}));

/**
 * The bottom-sheet branch tags its surface; the dropdown branch does not.
 *
 * Counted rather than asserted present/absent: a second drawer is exactly the
 * bug, so "how many" is the question, and `toBe(0)` and `toBe(1)` are
 * different failures from each other.
 */
const drawerCount = () =>
    document.querySelectorAll('[data-popover-drawer]').length;

describe('a Popover nested inside a sheet', () => {
    it('mounts a drawer when it is NOT nested (the normal mobile case)', async () => {
        render(
            <Popover openPopover setOpenPopover={() => {}} content={<div>picker</div>}>
                <button type="button">open</button>
            </Popover>,
        );

        // The whole point of the primitive on mobile: a bottom sheet.
        expect(await screen.findByText('picker')).toBeInTheDocument();
        expect(drawerCount()).toBe(1);
    });

    it('does NOT mount a second drawer when it IS nested', async () => {
        // A searchable Combobox inside a Modal. Two drawers would mean
        // overlapping scroll locks, a drag gesture that dismisses the wrong
        // sheet, and an escape key that closes both or neither.
        render(
            <OverlayDepthProvider>
                <Popover
                    openPopover
                    setOpenPopover={() => {}}
                    content={<div>picker</div>}
                >
                    <button type="button">open</button>
                </Popover>
            </OverlayDepthProvider>,
        );

        expect(await screen.findByText('picker')).toBeInTheDocument();

        // The content is still there — it just presents as a popover, not a
        // sheet.
        expect(drawerCount()).toBe(0);
    });

    it('forceDropdown still works as an explicit override', async () => {
        // The prop is kept. The existing call sites become redundant rather than
        // wrong, and a caller who knows something the tree does not can still
        // say so.
        render(
            <Popover
                openPopover
                setOpenPopover={() => {}}
                forceDropdown
                content={<div>picker</div>}
            >
                <button type="button">open</button>
            </Popover>,
        );

        expect(await screen.findByText('picker')).toBeInTheDocument();
        expect(drawerCount()).toBe(0);
    });

    it('renders ONE backdrop, not two', async () => {
        // A second `<Drawer.Overlay />` used to be rendered after
        // `Drawer.Content`: the blur applied twice and the stray element sat
        // above the content in paint order.
        const { baseElement } = render(
            <Popover openPopover setOpenPopover={() => {}} content={<div>picker</div>}>
                <button type="button">open</button>
            </Popover>,
        );

        expect(await screen.findByText('picker')).toBeInTheDocument();
        expect(
            baseElement.querySelectorAll('[data-vaul-overlay], [data-radix-dialog-overlay]')
                .length,
        ).toBeLessThanOrEqual(1);
    });
});
