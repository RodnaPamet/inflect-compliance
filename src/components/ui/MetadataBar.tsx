"use client";

/**
 * `<MetadataBar>` — single-line metadata strip for detail pages (v2-PR-13).
 *
 * Replaces the 6 different metadata layouts that detail pages
 * currently use (sidebar, header description, separate Card under
 * the header, inline meta row) with one canonical horizontal strip.
 *
 * Visual shape:
 *
 *   {Label}: {value} · {Label}: {value} · {Label}: {value} · +N more
 *
 *   - Each item is `{label}: {value}` separated by a middle dot.
 *   - Up to 6 items visible; remainder collapses to "+N more"
 *     summary chip.
 *   - Labels are uppercase muted (eyebrow typography); values are
 *     content-default text-sm.
 *
 * Why a single strip:
 *   - Every detail page currently solves "show metadata" differently.
 *     Reading the same product across surfaces feels like reading
 *     three products.
 *   - The strip is dense and scannable — premium products
 *     (Linear issue header, Stripe transaction detail) all use this
 *     shape.
 *
 * Pairs with:
 *   - `<EntityDetailLayout>` (v2-PR-5 / PR-6) — the metadata bar
 *     belongs below the page header, above the tab bar.
 *   - `<PageHeader meta>` (v2-PR-5) — that slot was the previous
 *     mechanism. New code should reach for `<MetadataBar>` so the
 *     metadata strip is consistent across detail pages.
 */

import * as React from "react";
import { cn } from "@inflect/ui/lib/cn";

export interface MetadataBarItem {
    /** Stable id (key) — also used by `data-metadata-bar-item-id`. */
    id: string;
    /** Label rendered uppercase + muted before the value. */
    label: React.ReactNode;
    /** Value rendered inline after the label. */
    value: React.ReactNode;
}

export interface MetadataBarProps {
    items: ReadonlyArray<MetadataBarItem>;
    /**
     * Maximum number of items rendered inline before the "+N more"
     * collapse. Defaults to 6 — premium products (Linear, Stripe)
     * cap dense metadata strips around 6 columns. Pages with more
     * stats should consider whether they all belong on the strip
     * vs. moving some into the body content.
     */
    maxVisible?: number;
    className?: string;
    "data-testid"?: string;
}

const DEFAULT_MAX_VISIBLE = 6;

export function MetadataBar({
    items,
    maxVisible = DEFAULT_MAX_VISIBLE,
    className,
    "data-testid": dataTestId,
}: MetadataBarProps) {
    if (items.length === 0) return null;

    const visible = items.slice(0, maxVisible);
    const overflow = items.length - visible.length;

    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-x-tight gap-y-1 text-sm",
                className,
            )}
            data-metadata-bar
            data-testid={dataTestId}
        >
            {visible.map((item, idx) => (
                <React.Fragment key={item.id}>
                    {idx > 0 && (
                        <span
                            className="text-content-subtle"
                            aria-hidden="true"
                        >
                            ·
                        </span>
                    )}
                    <span
                        className="inline-flex items-baseline gap-1"
                        data-metadata-bar-item
                        data-metadata-bar-item-id={item.id}
                    >
                        <span className="text-xs text-content-muted uppercase tracking-wide font-medium">
                            {item.label}
                        </span>
                        <span className="text-content-default">
                            {item.value}
                        </span>
                    </span>
                </React.Fragment>
            ))}
            {overflow > 0 && (
                <>
                    <span
                        className="text-content-subtle"
                        aria-hidden="true"
                    >
                        ·
                    </span>
                    <span
                        className="text-xs text-content-muted"
                        data-metadata-bar-overflow
                    >
                        +{overflow} more
                    </span>
                </>
            )}
        </div>
    );
}
