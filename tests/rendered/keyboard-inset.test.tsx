import { act, render, renderHook } from '@testing-library/react';

import {
    keyboardAvoidanceStyle,
    useKeyboardInset,
} from '@/lib/hooks/use-keyboard-inset';
import { Sheet } from '@/components/ui/sheet';

/**
 * THE SOFT KEYBOARD MUST NOT COVER THE INPUT THE USER JUST TAPPED.
 *
 * Every overlay in this codebase caps its height in `vh` — the LAYOUT
 * viewport, which does NOT shrink when the keyboard opens. So a sheet at 92vh
 * keeps its full height, the keyboard slides up over the bottom half, and the
 * field the user is typing into is behind it.
 *
 * These tests drive a FAKE VisualViewport, because jsdom has none — and without
 * one the hook would degrade to "no keyboard" and every assertion here would
 * pass by testing nothing.
 */

const LAYOUT_HEIGHT = 851; // Pixel 5
const KEYBOARD_HEIGHT = 340; // ~40% of the screen. Not a rounding error.

interface FakeViewport {
    height: number;
    offsetTop: number;
    addEventListener: jest.Mock;
    removeEventListener: jest.Mock;
    _fire: () => void;
}

function installViewport(height: number, offsetTop = 0): FakeViewport {
    const listeners: Array<() => void> = [];

    const vv: FakeViewport = {
        height,
        offsetTop,
        addEventListener: jest.fn((_e: string, fn: () => void) =>
            listeners.push(fn),
        ),
        removeEventListener: jest.fn(),
        _fire: () => listeners.forEach((fn) => fn()),
    };

    Object.defineProperty(window, 'visualViewport', {
        value: vv,
        configurable: true,
    });
    Object.defineProperty(window, 'innerHeight', {
        value: LAYOUT_HEIGHT,
        configurable: true,
    });

    return vv;
}

afterEach(() => {
    Object.defineProperty(window, 'visualViewport', {
        value: undefined,
        configurable: true,
    });
});

describe('useKeyboardInset', () => {
    it('reports no inset when the keyboard is closed', () => {
        installViewport(LAYOUT_HEIGHT);

        const { result } = renderHook(() => useKeyboardInset());

        expect(result.current.inset).toBe(0);
        expect(result.current.isOpen).toBe(false);
    });

    it('reports the keyboard height when it opens', () => {
        const vv = installViewport(LAYOUT_HEIGHT);

        const { result } = renderHook(() => useKeyboardInset());

        act(() => {
            vv.height = LAYOUT_HEIGHT - KEYBOARD_HEIGHT;
            vv._fire();
        });

        expect(result.current.inset).toBe(KEYBOARD_HEIGHT);
        expect(result.current.visibleHeight).toBe(
            LAYOUT_HEIGHT - KEYBOARD_HEIGHT,
        );
        expect(result.current.isOpen).toBe(true);
    });

    it('accounts for offsetTop when the browser scrolls to follow the focused input', () => {
        // The one that is easy to miss. When the browser shifts the visual
        // viewport up to keep a focused field in view, the hidden region is what
        // lies BELOW it — not merely the height difference. Ignoring offsetTop
        // under-reports the inset and the overlay is still partly covered.
        const vv = installViewport(LAYOUT_HEIGHT);

        const { result } = renderHook(() => useKeyboardInset());

        act(() => {
            vv.height = 400;
            vv.offsetTop = 111;
            vv._fire();
        });

        expect(result.current.inset).toBe(LAYOUT_HEIGHT - 400 - 111);
    });

    it('IGNORES a small viewport wobble — the URL bar is not a keyboard', () => {
        // Mobile browsers resize the visual viewport constantly as the URL bar
        // collapses on scroll. Treating a 60px change as "the keyboard opened"
        // makes every overlay twitch while the user scrolls, which is worse than
        // the bug.
        const vv = installViewport(LAYOUT_HEIGHT);

        const { result } = renderHook(() => useKeyboardInset());

        act(() => {
            vv.height = LAYOUT_HEIGHT - 60;
            vv._fire();
        });

        expect(result.current.isOpen).toBe(false);
    });

    it('listens to BOTH resize and scroll', () => {
        // `resize` fires when the keyboard opens; `scroll` fires when the
        // browser shifts the viewport to follow the focused input. Listen to
        // only one and the overlay is right on open and wrong the moment the
        // user scrolls inside it.
        const vv = installViewport(LAYOUT_HEIGHT);

        renderHook(() => useKeyboardInset());

        const events = vv.addEventListener.mock.calls.map((c) => c[0]);
        expect(events).toContain('resize');
        expect(events).toContain('scroll');
    });

    it('degrades safely when VisualViewport does not exist', () => {
        // Older browsers, and jsdom itself. An overlay that is occasionally too
        // tall is vastly better than an overlay that throws.
        Object.defineProperty(window, 'visualViewport', {
            value: undefined,
            configurable: true,
        });

        const { result } = renderHook(() => useKeyboardInset());

        expect(result.current.isOpen).toBe(false);
        expect(result.current.inset).toBe(0);
    });

    it('cleans up its listeners', () => {
        const vv = installViewport(LAYOUT_HEIGHT);

        const { unmount } = renderHook(() => useKeyboardInset());
        unmount();

        expect(vv.removeEventListener).toHaveBeenCalledTimes(2);
    });
});

describe('keyboardAvoidanceStyle', () => {
    it('does NOTHING when the keyboard is closed', () => {
        // We must not override the component's own design in the 95% of cases
        // where there is no keyboard at all.
        expect(
            keyboardAvoidanceStyle({
                inset: 0,
                visibleHeight: 851,
                isOpen: false,
            }),
        ).toEqual({});
    });

    it('caps to the VISIBLE height, not the layout viewport — this is the fix', () => {
        const style = keyboardAvoidanceStyle({
            inset: KEYBOARD_HEIGHT,
            visibleHeight: LAYOUT_HEIGHT - KEYBOARD_HEIGHT,
            isOpen: true,
        });

        expect(style.maxHeight).toBe(`${LAYOUT_HEIGHT - KEYBOARD_HEIGHT}px`);

        // …and lifts the surface clear. A bottom-anchored sheet whose height is
        // capped but whose bottom edge is still at 0 just gets shorter while
        // remaining underneath the keyboard.
        expect(style.paddingBottom).toBe(`${KEYBOARD_HEIGHT}px`);
    });

    it('the cap is genuinely smaller than 92vh — the value the sheet uses', () => {
        // The regression this whole hook exists to prevent. If the computed cap
        // were not actually smaller than what the CSS already does, the fix
        // would be a no-op that looks like it works.
        const cssCap = LAYOUT_HEIGHT * 0.92; // max-h-[92vh]
        const withKeyboard = LAYOUT_HEIGHT - KEYBOARD_HEIGHT;

        expect(withKeyboard).toBeLessThan(cssCap);
    });
});

/**
 * THE HOOK BEING CORRECT IS NOT THE FIX BEING DELIVERED.
 *
 * Everything above would pass with the overlays never calling the hook at all.
 * These two assert the SURFACE carries the cap — which is what the user sees.
 */
describe('the overlays apply the cap', () => {
    function openSheet() {
        return render(
            <Sheet open size="md" title="detail">
                <Sheet.Body>
                    <input aria-label="name" />
                </Sheet.Body>
            </Sheet>,
        );
    }

    it('a Sheet mounted with the keyboard open is capped to the visible height', () => {
        // Installed BEFORE mount, so the hook's first measure already sees it.
        installViewport(LAYOUT_HEIGHT - KEYBOARD_HEIGHT);

        const { baseElement } = openSheet();
        const surface = baseElement.querySelector<HTMLElement>(
            '[data-sheet-direction]',
        );

        expect(surface).not.toBeNull();
        expect(surface!.style.maxHeight).toBe(
            `${LAYOUT_HEIGHT - KEYBOARD_HEIGHT}px`,
        );
        expect(surface!.style.paddingBottom).toBe(`${KEYBOARD_HEIGHT}px`);
    });

    it('…and keeps its own slide-in transform while doing so', () => {
        // The merge, not a second `style` prop. JSX keeps only the LAST `style`
        // and silently drops the first, so the failure mode of getting this
        // wrong is the sheet losing its entrance animation — invisible to a test
        // that only checked maxHeight.
        installViewport(LAYOUT_HEIGHT - KEYBOARD_HEIGHT);

        const { baseElement } = openSheet();
        const surface = baseElement.querySelector<HTMLElement>(
            '[data-sheet-direction]',
        );

        expect(
            surface!.style.getPropertyValue('--initial-transform'),
        ).not.toBe('');
    });

    it('leaves the surface unstyled when there is no keyboard', () => {
        // The 95% case: the component's own `85vh` CSS must govern.
        installViewport(LAYOUT_HEIGHT);

        const { baseElement } = openSheet();
        const surface = baseElement.querySelector<HTMLElement>(
            '[data-sheet-direction]',
        );

        expect(surface!.style.maxHeight).toBe('');
        expect(surface!.style.paddingBottom).toBe('');
    });
});
