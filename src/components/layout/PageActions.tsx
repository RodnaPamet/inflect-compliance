'use client';

/**
 * `<PageActions>` — Roadmap-3 PR-1.
 *
 * The single canonical shape for every page-header action cluster
 * across the product. Until this PR each page hand-rolled its own
 * `<>...</>` fragment with mixed button sizes, gaps, and order —
 * the user observed the inconsistency directly ("action buttons in
 * the top right of each page have differences in position, size,
 * and color").
 *
 * What `<PageActions>` locks
 *   • Layout — `flex flex-wrap-reverse items-center justify-end gap-tight`.
 *     `flex-wrap-reverse` keeps the rightmost button (typically
 *     primary) visually rightmost even when the cluster wraps to a
 *     second line on a narrow viewport.
 *   • Right-alignment — the cluster always pushes to the trailing
 *     edge of the page-header row.
 *   • Spacing — `gap-tight` (8 px) between buttons, no exceptions.
 *   • Min height — `min-h-9` so the cluster's vertical footprint
 *     matches `<Button size="sm">`'s `h-9` and the row never reads
 *     as ragged.
 *
 * What it does NOT do
 *   • Doesn't enforce button SIZE — that's the
 *     `tests/guards/page-actions-discipline.test.ts` ratchet's
 *     job. The primitive is the layout; the ratchet is the
 *     discipline.
 *   • Doesn't own button content — pages still pass their own
 *     `<Button>` / `<Link>` children. The primitive only owns
 *     the cluster geometry.
 *
 * How `<PageHeader>` uses it
 *   `<PageHeader>` wraps its `actions` slot in `<PageActions>`
 *   automatically. Pages that pass actions to PageHeader get the
 *   canonical shape without changing their call site.
 */
import { type ReactNode } from 'react';
import { cn } from '@inflect/ui/lib/cn';

export interface PageActionsProps {
    children: ReactNode;
    /** Layout overrides on the outer cluster element. */
    className?: string;
    /** Forwarded to the outer element (E2E selectors). */
    'data-testid'?: string;
}

export function PageActions({
    children,
    className,
    'data-testid': dataTestId,
}: PageActionsProps) {
    return (
        <div
            className={cn(
                // flex-wrap-reverse keeps primary (rightmost) at
                // the right edge when wrapping. min-h-9 matches
                // <Button size="sm">'s h-9 so vertical alignment
                // stays clean even with mixed-height children.
                'flex flex-wrap-reverse items-center justify-end gap-tight min-h-9',
                className,
            )}
            data-testid={dataTestId ?? 'page-actions'}
        >
            {children}
        </div>
    );
}
