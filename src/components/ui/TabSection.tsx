"use client";

/**
 * `<TabSection>` — standardised tab body wrapper (v2-PR-13).
 *
 * Owns the layout contract for any tab body inside an
 * `<EntityDetailLayout>` (or any tabbed surface). Replaces the
 * hand-rolled `<div className="space-y-section">` + inline heading
 * + ad-hoc action cluster patterns that drifted between tabs.
 *
 * Shape:
 *
 *   ┌────────────────────────────────────────┐
 *   │ {title}                    {actions}   │
 *   │ {description}                          │
 *   │                                        │
 *   │ {children}                             │
 *   └────────────────────────────────────────┘
 *
 * Render contract:
 *   - Outer wrapper carries `space-y-section` (semantic from
 *     v2-PR-2) so direct children are spaced consistently.
 *   - Optional title row: `<Heading level={2}>` + right-aligned
 *     action cluster.
 *   - Optional description below title (muted).
 *   - Children render unwrapped — pages compose freely.
 *
 * Why a single wrapper:
 *   - Detail pages today have wildly different tab body rhythm.
 *     One tab uses h3 headings, another uses h2; one has
 *     `space-y-section`, another `space-y-default`.
 *   - The wrapper makes "tab body" a typed surface so changes
 *     (heading rhythm, future eyebrow slot, …) land in one place.
 */

import * as React from "react";
import { cn } from "@inflect/ui/lib/cn";

import { Heading } from "./typography";

export interface TabSectionProps {
    /**
     * Optional title rendered as `<Heading level={2}>`. When
     * omitted, the section renders unheaded — useful when the tab
     * body's first child IS its own heading.
     */
    title?: React.ReactNode;
    /**
     * Optional description rendered below the title. Muted body
     * copy. Ignored when `title` is omitted.
     */
    description?: React.ReactNode;
    /**
     * Right-aligned action cluster on the title row. Typically a
     * single primary action button or 1 secondary + overflow menu.
     */
    actions?: React.ReactNode;
    /** Tab body content. */
    children: React.ReactNode;
    /** Layout overrides on the outer wrapper. */
    className?: string;
    /** Forwarded to the outer wrapper for E2E selectors. */
    "data-testid"?: string;
}

export function TabSection({
    title,
    description,
    actions,
    children,
    className,
    "data-testid": dataTestId,
}: TabSectionProps) {
    const hasHeader = title || actions;
    return (
        <section
            className={cn("space-y-section", className)}
            data-tab-section
            data-testid={dataTestId}
        >
            {hasHeader && (
                <div
                    className="flex items-start justify-between gap-default flex-wrap"
                    data-tab-section-header
                >
                    {title && (
                        <div className="min-w-0">
                            <Heading
                                level={2}
                                data-testid="tab-section-title"
                            >
                                {title}
                            </Heading>
                            {description && (
                                <p
                                    className="text-sm text-content-muted mt-tight max-w-prose"
                                    data-testid="tab-section-description"
                                >
                                    {description}
                                </p>
                            )}
                        </div>
                    )}
                    {actions && (
                        <div
                            className="flex gap-tight flex-wrap"
                            data-testid="tab-section-actions"
                        >
                            {actions}
                        </div>
                    )}
                </div>
            )}
            {children}
        </section>
    );
}
