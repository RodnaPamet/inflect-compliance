/**
 * Every bottom sheet on a phone — the Popover's drawer, the Modal's drawer,
 * the Sheet's bottom variant — STACKS its content, clears the home indicator
 * and sizes by the dynamic viewport.
 *
 * Three defects, one per assertion group, each found on a real phone:
 *
 *   - The Popover's drawer body was `flex items-center justify-center
 *     overflow-hidden`: a ROW. The user menu passes a fragment (identity
 *     header, theme row, language row, menu), so on every page its children sat
 *     side by side, clipped at both edges, and only "Sign out" was readable.
 *
 *   - No sheet padded for `env(safe-area-inset-bottom)`, so a modal's sticky
 *     Cancel / Create footer and a sheet's last row sat in the home-indicator
 *     zone, where a tap triggers the system gesture.
 *
 *   - Heights were in `vh` — the viewport with the browser chrome HIDDEN — so
 *     while the chrome showed, a sheet was taller than the screen and its
 *     bottom was cut off. `dvh` is the viewport as it is; `vh` stays only as
 *     the fallback for a browser without it.
 *
 * jsdom applies no stylesheet, so layout itself cannot be measured here: the
 * classes that PRODUCE the layout are what is asserted, read off the rendered
 * element rather than the source text.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({
        device: 'mobile' as const,
        width: 390,
        height: 844,
        isMobile: true,
        isTablet: false,
        isDesktop: false,
    }),
}));

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/risks',
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

import { Popover } from '@/components/ui/popover';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';

const LAYOUT_HEIGHT = 844;
const KEYBOARD_HEIGHT = 340;

function installViewport(height: number) {
    Object.defineProperty(window, 'visualViewport', {
        value: {
            height,
            offsetTop: 0,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        },
        configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', { value: LAYOUT_HEIGHT, configurable: true });
}

afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
});

const classesOf = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

// ─── The Popover's drawer ───────────────────────────────────────────

describe('the Popover bottom sheet', () => {
    function openWithSeveralRoots() {
        render(
            <Popover
                openPopover
                setOpenPopover={() => {}}
                content={
                    <>
                        <div data-testid="identity">Ada Lovelace · ada@example.com</div>
                        <div data-testid="theme-row">Theme</div>
                        <Popover.Menu aria-label="Account">
                            <Popover.Item>Profile</Popover.Item>
                            <Popover.Item>Sign out</Popover.Item>
                        </Popover.Menu>
                    </>
                }
            >
                <button type="button">avatar</button>
            </Popover>,
        );
        return document.querySelector('[data-popover-drawer-body]');
    }

    it('stacks several root nodes in a column that spans the sheet, rather than a row', () => {
        const body = openWithSeveralRoots();
        expect(body).not.toBeNull();
        const cls = classesOf(body);

        expect(cls).toContain('flex-col');
        expect(cls).toContain('items-stretch');
        // The row recipe is what clipped the user menu at both edges.
        expect(cls).not.toContain('items-center');
        expect(cls).not.toContain('justify-center');

        // Every root node is a direct child of that column — none is wrapped
        // in something that could reintroduce a row.
        for (const id of ['identity', 'theme-row']) {
            expect(screen.getByTestId(id).parentElement).toBe(body);
        }
        expect(screen.getByRole('menu', { name: 'Account' }).parentElement).toBe(body);
    });

    it('scrolls a tall body instead of clipping it, inside a dvh cap', () => {
        const body = openWithSeveralRoots();
        expect(classesOf(body)).toContain('overflow-y-auto');
        expect(classesOf(body)).not.toContain('overflow-hidden');

        const sheet = document.querySelector('[data-popover-drawer]');
        expect(classesOf(sheet)).toEqual(
            expect.arrayContaining(['flex', 'flex-col', 'max-h-[85vh]', 'supports-[height:100dvh]:max-h-[85dvh]']),
        );
    });

    it('pads the body clear of the home indicator while the keyboard is closed', () => {
        installViewport(LAYOUT_HEIGHT);
        const body = openWithSeveralRoots();
        expect(classesOf(body)).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
    });

    it('drops the inset while the keyboard is open, leaving the keyboard lift in charge', () => {
        installViewport(LAYOUT_HEIGHT - KEYBOARD_HEIGHT);
        const body = openWithSeveralRoots();
        expect(classesOf(body)).toContain('pb-4');
        expect(classesOf(body)).not.toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');

        const sheet = document.querySelector<HTMLElement>('[data-popover-drawer]');
        expect(sheet!.style.paddingBottom).toBe(`${KEYBOARD_HEIGHT}px`);
    });

    it('gives a menu row a 44px floor for a finger', () => {
        openWithSeveralRoots();
        expect(classesOf(screen.getByRole('menuitem', { name: 'Profile' }))).toContain(
            'pointer-coarse:min-h-11',
        );
    });
});

// ─── The Modal's drawer ─────────────────────────────────────────────

describe('the Modal bottom sheet', () => {
    function openModal() {
        render(
            <Modal showModal setShowModal={() => {}} title="New risk">
                <Modal.Body>
                    <input aria-label="Title" />
                </Modal.Body>
                <Modal.Actions>
                    <button type="button">Create</button>
                </Modal.Actions>
            </Modal>,
        );
        const wrapper = document.querySelector('[data-modal-body-wrapper]');
        expect(wrapper).not.toBeNull();
        // The drawer surface is the body wrapper's parent.
        return wrapper!.parentElement as HTMLElement;
    }

    it('pads the sheet — and so its sticky footer — clear of the home indicator', () => {
        installViewport(LAYOUT_HEIGHT);
        const sheet = openModal();
        expect(classesOf(sheet)).toContain('pb-[env(safe-area-inset-bottom)]');
        // The footer is inside the padded sheet, not beside it.
        expect(sheet.contains(screen.getByRole('button', { name: 'Create' }))).toBe(true);
        // No inline padding is fighting the class while the keyboard is closed.
        expect(sheet.style.paddingBottom).toBe('');
    });

    it('caps its height in dvh, keeping vh as the fallback', () => {
        const sheet = openModal();
        expect(classesOf(sheet)).toEqual(
            expect.arrayContaining(['max-h-[92vh]', 'supports-[height:100dvh]:max-h-[92dvh]']),
        );
    });

    it('still lifts the sheet clear of an open keyboard', () => {
        installViewport(LAYOUT_HEIGHT - KEYBOARD_HEIGHT);
        const sheet = openModal();
        expect(sheet.style.maxHeight).toBe(`${LAYOUT_HEIGHT - KEYBOARD_HEIGHT}px`);
        // Inline, so it overrides the safe-area class: the keyboard is the
        // bigger lift, and the home indicator is under it.
        expect(sheet.style.paddingBottom).toBe(`${KEYBOARD_HEIGHT}px`);
    });
});

// ─── The Sheet's bottom variant ─────────────────────────────────────

describe('the Sheet on a phone', () => {
    function openSheet() {
        render(
            <Sheet open size="md" title="Finding">
                <Sheet.Body>body</Sheet.Body>
            </Sheet>,
        );
        return document.querySelector<HTMLElement>('[data-sheet-direction]');
    }

    it('is the bottom variant', () => {
        expect(openSheet()?.getAttribute('data-sheet-direction')).toBe('bottom');
    });

    it('sits on the larger of its margin and the home-indicator inset', () => {
        const cls = classesOf(openSheet());
        expect(cls).toContain('bottom-[var(--sheet-bottom)]');
        expect(cls).toContain('[--sheet-bottom:max(var(--sheet-margin),env(safe-area-inset-bottom))]');
        expect(cls).not.toContain('bottom-2');
    });

    it('sizes by the dynamic viewport, less the space it sits off the bottom', () => {
        const cls = classesOf(openSheet());
        expect(cls).toEqual(
            expect.arrayContaining([
                'h-[min(var(--sheet-height),calc(var(--sheet-viewport)-var(--sheet-margin)-var(--sheet-bottom)))]',
                '[--sheet-viewport:100vh]',
                'supports-[height:100dvh]:[--sheet-viewport:100dvh]',
                'supports-[height:100dvh]:[--sheet-height:85dvh]',
            ]),
        );
    });
});
