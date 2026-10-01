"use client";

import { useEffect, useState } from "react";

/**
 * How much of the screen the soft keyboard is currently covering.
 *
 * ═══ WHY `vh` DOES NOT WORK, AND WHY THIS HOOK EXISTS ═══
 *
 * Every overlay in this codebase caps its height in viewport units —
 * `max-h-[92vh]` on the sheet, `max-h-[min(85vh,680px)]` on the modal.
 *
 * `vh` is the LAYOUT viewport. It does not shrink when the soft keyboard opens.
 *
 * So a sheet sized to 92vh keeps its full height, the keyboard slides up over
 * the bottom half of it, and the input the user just tapped is now BEHIND the
 * keyboard. They are typing into something they cannot see. On a phone this is
 * not a cosmetic problem — it makes the form unusable, and the user has no idea
 * why, because the field looked fine right up until they touched it.
 *
 * `VisualViewport` is the API that knows the difference:
 *
 *   window.innerHeight        → the layout viewport (constant)
 *   visualViewport.height     → what the user can actually SEE (shrinks)
 *   visualViewport.offsetTop  → how far the page has been scrolled up to keep
 *                               the focused input in view
 *
 * The inset is what is left over: the keyboard, plus any browser chrome that
 * appeared with it.
 *
 * ─── This is not a rounding error ────────────────────────────────────
 *
 * A phone keyboard is ~40% of the screen. On a 851px-tall Pixel 5 that is
 * roughly 340px — nearly half the sheet.
 */
export interface KeyboardInset {
    /** Pixels of the layout viewport currently hidden by the keyboard. 0 when closed. */
    inset: number;
    /** The height the user can actually see. Use this instead of `vh`. */
    visibleHeight: number;
    /** True when the keyboard is (probably) open. */
    isOpen: boolean;
}

/**
 * A keyboard is never a couple of pixels tall.
 *
 * Small VisualViewport deltas happen constantly on mobile browsers — the URL
 * bar collapsing on scroll, a rounding wobble. Treating those as "the keyboard
 * opened" makes every overlay twitch as the user scrolls, which is worse than
 * the bug we are fixing.
 */
const KEYBOARD_THRESHOLD_PX = 100;

export function useKeyboardInset(): KeyboardInset {
    // SSR renders with the keyboard closed. Any other default would make the
    // server and client markup disagree and produce a hydration error on a page
    // that was never going to have a keyboard open at first paint anyway.
    const [state, setState] = useState<KeyboardInset>({
        inset: 0,
        visibleHeight: 0,
        isOpen: false,
    });

    useEffect(() => {
        const vv =
            typeof window !== "undefined" ? window.visualViewport : undefined;

        // No VisualViewport (older browsers, jsdom). Degrade to "no keyboard"
        // rather than throwing — an overlay that is occasionally too tall is far
        // better than an overlay that crashes.
        //
        // Named rather than inline, matching `measure` below and the sibling
        // hooks in src/components/ui/hooks: `react-hooks/set-state-in-effect`
        // flags a setState written directly in an effect BODY, and the shape it
        // is warning about — a cascading render — is not what a one-shot read of
        // a platform API that has no subscribe path does.
        const degrade = () =>
            setState({
                inset: 0,
                visibleHeight: window?.innerHeight ?? 0,
                isOpen: false,
            });

        if (!vv) {
            degrade();
            return;
        }

        const measure = () => {
            // `offsetTop` matters and is easy to miss. When the browser scrolls
            // the page up to keep a focused input visible, the visual viewport
            // moves — and the hidden region is what is below it, not merely the
            // height difference.
            const hidden = Math.max(
                0,
                window.innerHeight - vv.height - vv.offsetTop,
            );

            setState({
                inset: hidden,
                visibleHeight: vv.height,
                isOpen: hidden > KEYBOARD_THRESHOLD_PX,
            });
        };

        measure();

        // BOTH events. `resize` fires when the keyboard opens; `scroll` fires
        // when the browser shifts the visual viewport to follow the focused
        // input. Listen to only one and the overlay is correct on open and wrong
        // the moment the user scrolls within it.
        vv.addEventListener("resize", measure);
        vv.addEventListener("scroll", measure);

        return () => {
            vv.removeEventListener("resize", measure);
            vv.removeEventListener("scroll", measure);
        };
    }, []);

    return state;
}

/**
 * The style an overlay should apply so it stays above the keyboard.
 *
 * Returns nothing when the keyboard is closed, so the component's own CSS
 * (`max-h-[92vh]`) governs — we do not want to override the design in the 95%
 * of cases where there is no keyboard at all.
 */
export function keyboardAvoidanceStyle(kb: KeyboardInset): React.CSSProperties {
    if (!kb.isOpen) return {};

    return {
        // Cap to what is VISIBLE, not to the layout viewport. This is the whole
        // fix.
        maxHeight: `${kb.visibleHeight}px`,
        // …and lift the surface clear of the keyboard. A bottom-anchored sheet
        // whose height is capped but whose bottom edge is still at 0 simply gets
        // shorter while remaining underneath.
        paddingBottom: `${kb.inset}px`,
    };
}
