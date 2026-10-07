"use client";

/**
 * Epic 54 — responsive presentation hook.
 *
 * One opinionated API for "which surface should I render on this viewport?"
 * — the same decision `<Modal>`, `<Popover>`, and future overlays must make.
 * Codifies the rule so every consumer answers it the same way.
 *
 * Output contract:
 *   - `"dialog"`: Radix Dialog overlay (desktop default).
 *   - `"drawer"`: Vaul bottom drawer (mobile default).
 *   - `"sheet"`: Vaul right-side sheet (desktop detail panels).
 *
 * Sizing rule: sheet is a desktop-only surface; on mobile it collapses to a
 * drawer so small-screen users don't get a tiny side panel they can't drag.
 */

import { useMediaQuery } from "./use-media-query";

export type ResponsivePresentation = "dialog" | "drawer" | "sheet";

export interface UseResponsivePresentationOptions {
    /**
     * Preferred surface. Defaults to `"dialog"`.
     *   - `"dialog"`  → Dialog on desktop, Drawer on mobile.
     *   - `"sheet"`   → Sheet on desktop, Drawer on mobile.
     *   - `"drawer"`  → Drawer on all viewports.
     */
    prefer?: ResponsivePresentation;
    /**
     * Force a surface regardless of viewport. Useful for preview screens,
     * A/B tests, or stories. Takes precedence over `prefer`.
     */
    force?: ResponsivePresentation;
}

export interface UseResponsivePresentation {
    /** Resolved surface for the current viewport. */
    presentation: ResponsivePresentation;
    /** Viewport flags, re-exported for consumers that need the raw signal. */
    isMobile: boolean;
    isTablet: boolean;
    isDesktop: boolean;
}

export function useResponsivePresentation(
    options: UseResponsivePresentationOptions = {},
): UseResponsivePresentation {
    const { prefer = "dialog", force } = options;
    const { isMobile, isTablet, isDesktop } = useMediaQuery();

    const presentation: ResponsivePresentation = force
        ? force
        : resolvePresentation({ prefer, isMobile });

    return { presentation, isMobile, isTablet, isDesktop };
}

/**
 * Pure decision logic — exported so tests and the `resolveModalPresentation`
 * helper in `modal.tsx` stay in sync with the hook's rule.
 */
export function resolvePresentation(opts: {
    prefer: ResponsivePresentation;
    isMobile: boolean;
}): ResponsivePresentation {
    if (opts.prefer === "drawer") return "drawer";
    if (opts.isMobile) return "drawer";
    // Desktop: honour the preference.
    return opts.prefer; // "dialog" or "sheet"
}
