"use client";

import { useEffect, useState } from "react";

/**
 * True when the viewport is below Tailwind's `md` breakpoint (768px) — i.e. a
 * phone. Shared by responsive surfaces that swap layout on mobile (the
 * `<DataTable>` card view, the dashboard's single-column stack, …).
 *
 * Starts `false` on SSR + first client render (hydration-safe), then resolves
 * on mount via `matchMedia('(max-width: 767.98px)')`:
 *   - On a real phone the desktop layout paints one frame, then swaps — the
 *     same pattern the Modal/Sheet responsive presentation uses.
 *   - Under jsdom (no real viewport) `matchMedia(...).matches` is `false`, so
 *     tests render the DESKTOP layout by default — exactly what existing
 *     component tests expect. A test that wants the mobile branch mocks this
 *     hook to return `true`.
 */
export function useIsBelowMd(): boolean {
    const [belowMd, setBelowMd] = useState(false);

    useEffect(() => {
        if (typeof window === "undefined" || !window.matchMedia) return;
        const mql = window.matchMedia("(max-width: 767.98px)");
        const sync = () => setBelowMd(mql.matches);
        sync();
        mql.addEventListener("change", sync);
        return () => mql.removeEventListener("change", sync);
    }, []);

    return belowMd;
}
