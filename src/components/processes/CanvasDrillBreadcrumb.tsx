"use client";

/**
 * Epic P6-PR-A — Drill-down breadcrumb.
 *
 * Renders the navigation trail above the canvas when the user is
 * drilled into a sub-flow. At root the breadcrumb is hidden — no
 * point showing "All processes" with nothing after it.
 *
 * Clicking any crumb jumps directly to that level (the canvas
 * trims the drill stack to that depth).
 */

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

export function CanvasDrillBreadcrumb({
    trail,
    onJump,
}: {
    trail: Array<{ id: string | null; label: string }>;
    /**
     * Called with the target depth (0 = root, 1 = first level, …).
     * The canvas truncates `drillStack` to this length.
     */
    onJump: (targetDepth: number) => void;
}) {
    const t = useTranslations("automation.breadcrumb");
    if (trail.length <= 1) {
        // Root view — no trail to render.
        return null;
    }
    const items: ReactNode[] = [];
    trail.forEach((crumb, idx) => {
        const isLast = idx === trail.length - 1;
        items.push(
            <button
                key={`crumb-${idx}`}
                type="button"
                disabled={isLast}
                onClick={() => onJump(idx)}
                data-testid="canvas-drill-crumb"
                data-depth={idx}
                className={
                    isLast
                        ? "px-1 font-medium text-content-emphasis"
                        : "rounded-[4px] px-1 text-content-muted hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:bg-bg-muted"
                }
            >
                {crumb.label}
            </button>,
        );
        if (!isLast) {
            items.push(
                <span
                    key={`sep-${idx}`}
                    aria-hidden="true"
                    className="text-content-subtle"
                >
                    ›
                </span>,
            );
        }
    });
    return (
        <nav
            className="flex items-center gap-1 border-b border-canvas-border bg-canvas-frame px-default py-1 text-xs"
            aria-label={t("trailAria")}
            data-testid="canvas-drill-breadcrumb"
        >
            <span className="mr-1 font-semibold uppercase tracking-wider text-content-subtle">
                {t("youAreIn")}
            </span>
            {items}
        </nav>
    );
}
