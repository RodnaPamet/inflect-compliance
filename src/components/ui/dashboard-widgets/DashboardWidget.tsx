"use client";

/**
 * Epic 41 — `<DashboardWidget>` wrapper.
 *
 * Generic shell every dashboard widget composes:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ Title                       [actions]  │ ← header
 *   │ subtitle                                │
 *   ├─────────────────────────────────────────┤
 *   │                                         │
 *   │            (content slot)               │
 *   │                                         │
 *   ├─────────────────────────────────────────┘
 *   │                                       ⤡│ ← optional resize handle
 *   └─────────────────────────────────────────┘
 *
 * Visual: existing `glass-card` shell + the shared design tokens
 * (`text-content-emphasis`, `text-content-muted`, `border-border-subtle`).
 * No new visual language — the wrapper is a layout primitive that
 * inherits everything from the broader page chrome.
 *
 * The resize handle is a VISUAL AFFORDANCE only at this prompt's
 * scope. Actual resize wiring (drag mouse-events, grid integration)
 * lands in Epic 41 prompt 3 with `react-grid-layout`. The
 * `react-resizable-handle` className matches the upstream library's
 * default selector so the future grid wraps transparently.
 *
 * The actions slot accepts arbitrary React content — typically a
 * config-menu trigger (`<Popover><Button…/></Popover>`), a delete
 * button, or both. The wrapper doesn't render the menu itself —
 * keeping it generic so a consumer that wants an export button or
 * an inline filter can drop it in without forking the wrapper.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';

export interface DashboardWidgetProps {
    /** Header headline. Optional — when omitted, no header row is rendered. */
    title?: string;
    /** Optional secondary line beneath the title. */
    subtitle?: string;
    /**
     * Right-aligned actions surface — typically a config-menu trigger.
     * Caller is responsible for the popover / dropdown semantics; the
     * wrapper just allocates the slot.
     */
    actions?: ReactNode;
    /**
     * When true (default), renders a visual resize handle in the
     * bottom-right corner. The handle is presentational at this
     * prompt — the grid layout integration in prompt 3 will wire
     * the actual drag behaviour.
     */
    showResizeHandle?: boolean;
    /** Stable id passed through to the rendered element. */
    'data-widget-id'?: string;
    /**
     * Optional DOM `id` on the outer card. Used by E2E selectors that
     * predate the configurable widget engine (e.g. `#org-stat-coverage`,
     * `#org-drilldown-ctas`, `#org-tenant-coverage`) and by deep-link
     * anchors. The dispatcher derives this from the widget kind so the
     * IDs survive the rewire from hardcoded layout to widgets.
     */
    id?: string;
    /** Optional class merged onto the outer card. */
    className?: string;
    /** Whether the widget body should fill the card vertically. */
    fillBody?: boolean;
    children: ReactNode;
}

export function DashboardWidget({
    title,
    subtitle,
    actions,
    showResizeHandle = true,
    'data-widget-id': dataWidgetId,
    id,
    className,
    fillBody = true,
    children,
}: DashboardWidgetProps) {
    const showHeader = Boolean(title || subtitle || actions);

    return (
        <section
            data-widget-id={dataWidgetId}
            id={id}
            className={cn(
                cardVariants({ density: 'none' }),
                'relative flex h-full flex-col overflow-hidden',
                className,
            )}
            // The widget is an a11y-meaningful section IF it has a
            // title; otherwise it's a layout container and the
            // section role is dropped to keep the landmark tree clean.
            role={title ? 'region' : undefined}
            aria-label={title ?? undefined}
        >
            {showHeader && (
                <header
                    data-widget-header
                    className="flex items-start justify-between gap-compact border-b border-border-subtle px-4 py-3"
                >
                    <div className="min-w-0">
                        {title && (
                            <Heading level={3} className="truncate">
                                {title}
                            </Heading>
                        )}
                        {subtitle && (
                            <p className="mt-0.5 truncate text-xs text-content-muted">
                                {subtitle}
                            </p>
                        )}
                    </div>
                    {actions && (
                        <div
                            data-widget-actions
                            className="flex shrink-0 items-center gap-1"
                        >
                            {actions}
                        </div>
                    )}
                </header>
            )}

            <div
                data-widget-body
                className={[
                    'relative flex flex-col p-4',
                    fillBody ? 'flex-1 min-h-0' : '',
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {children}
            </div>

            {showResizeHandle && (
                // `react-resizable-handle` is the default selector
                // `react-grid-layout` expects when wiring resize. We
                // emit it presentationally now so the future grid
                // wraps the wrapper transparently. `aria-hidden`
                // keeps the visual icon out of the accessibility tree;
                // resize is a pointer / keyboard interaction owned by
                // the grid component, not the widget.
                <span
                    data-widget-resize-handle
                    aria-hidden="true"
                    className="react-resizable-handle pointer-events-auto absolute bottom-1 right-1 size-4 cursor-se-resize text-content-subtle/60 hover:text-content-muted"
                >
                    <svg
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="size-full"
                    >
                        <path d="M14 2v12H2v-2h10V2h2zM10 6v6H4v-2h4V6h2z" />
                    </svg>
                </span>
            )}
        </section>
    );
}
