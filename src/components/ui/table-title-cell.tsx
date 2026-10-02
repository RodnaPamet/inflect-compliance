'use client';

/**
 * R13-PR1 — `<TableTitleCell>`: the canonical title-column cell.
 *
 * Pre-R13 every entity list page (Controls, Risks, Vendors, Tasks,
 * Assets, Evidence, Policies, Findings) rendered its title cell
 * with a slightly different shape:
 *
 *   Controls   <div><Link className="font-medium text-content-emphasis ...">{code}</Link>
 *   Risks      <span className="font-medium text-content-emphasis text-sm">{title}</span>
 *   Policies   <Link className="font-medium text-content-emphasis ...">{title}</Link>
 *   Evidence   <div className="flex items-center gap-tight min-w-0"><Icon /><Link>...
 *   Tasks      <div><Link>...</Link> + inline SLA badges
 *   Vendors    <div className="font-medium"><Link className={textLinkVariants}>...</Link> + sub-processor
 *   Assets     <span className="font-medium text-content-emphasis">{name}</span>
 *   Findings   <span className="font-medium text-content-emphasis text-sm">{title}</span>
 *
 * Eight pages, eight subtly-different shapes — and the user could
 * see the difference. R13-PR1 collapses them into ONE primitive.
 *
 * Contract:
 *   - Renders a single inline element so row height stays at the
 *     DataTable primitive's ~44px baseline (no block children).
 *   - `font-medium text-content-emphasis text-sm` — the locked
 *     visual signature for "this is the row's identifier."
 *   - When `href` is provided, wraps in `<Link>` with the canonical
 *     hover transition (`hover:text-content-brand`).
 *   - When `href` is omitted, renders a `<span>` — the row's
 *     `onRowClick` carries the page-navigation contract for
 *     entire-row click targets (Risks / Assets / Findings).
 *
 * NOT a wrapper for icons, leading badges, trailing chips, or
 * sub-text. Pages that need those should put them in SEPARATE
 * columns. The title cell stays single-line, single-element.
 */

import { cn } from '@/lib/cn';
import Link from 'next/link';
import type { ReactNode } from 'react';

export interface TableTitleCellProps {
    /** The title text — usually `entity.title` / `entity.name` / `entity.code`. */
    children: ReactNode;
    /**
     * Optional href. When set, wraps the title in `<Link>` with the
     * canonical brand-tone hover. When omitted, renders a `<span>`
     * (whole-row `onRowClick` handles navigation).
     */
    href?: string;
    /** Forwarded to the underlying Link / span (E2E selector). */
    id?: string;
    /**
     * For the no-href branch only: where the brand-tone hover fires.
     *   - `'row'` (default) — tints when the whole ROW is hovered
     *     (`group-hover/row:`); the row owns navigation.
     *   - `'self'` — tints only when the NAME itself is hovered
     *     (`hover:`), matching the href/Link branch. Use when the title is
     *     wrapped in its own interactive element (e.g. the assets table's
     *     quick-look `<button>`) so the cue lands on the name, not the row.
     */
    tintOn?: 'row' | 'self';
    /** Override styling — additive to the canonical class string. */
    className?: string;
}

const TITLE_CELL_BASE =
    'font-medium text-content-emphasis text-sm';

const TITLE_CELL_LINK_HOVER =
    'hover:text-content-brand transition-colors duration-150 ease-out';

/**
 * Row-level hover tint applied on the **no-href** branch. When the
 * title is a plain `<span>` (whole-row `onRowClick` owns navigation),
 * the title text would otherwise stay static while the row hover
 * visibly changes — breaking the "I can click this" affordance.
 * Hooking into the existing `group/row` token on the `<tr>` paints
 * the title brand-color whenever the row is hovered, so the same
 * cue lands without re-introducing the per-cell hover that the
 * href branch already covers.
 */
const TITLE_CELL_ROW_HOVER =
    'group-hover/row:text-content-brand transition-colors duration-150 ease-out';

export function TableTitleCell({
    children,
    href,
    id,
    tintOn = 'row',
    className,
}: TableTitleCellProps) {
    if (href) {
        return (
            <Link
                href={href}
                id={id}
                className={cn(TITLE_CELL_BASE, TITLE_CELL_LINK_HOVER, className)}
                // R13-PR15 — single-click on the title link still
                // navigates via Next's default Link behaviour. We
                // intentionally do NOT `preventDefault` here — the
                // earlier attempt to make plain click toggle the
                // row's selection broke 6+ E2E suites and produced
                // a confusing UX where the most prominent visible
                // affordance (the title text styled as a link)
                // didn't act like a link.
                //
                // We also no longer `stopPropagation`. The row's
                // `onClick` fires alongside the link's navigation
                // — selection toggles in the background as the
                // page navigates away. Acceptable side effect;
                // preserves the standard link UX.
                //
                // For users who want pure click-to-select on the
                // row, click anywhere OTHER than the title link
                // (Status, Owner, empty cell space — anywhere a
                // <button>/<input>/<textarea> is not an ancestor).
            >
                {children}
            </Link>
        );
    }
    return (
        <span
            id={id}
            className={cn(
                TITLE_CELL_BASE,
                tintOn === 'self' ? TITLE_CELL_LINK_HOVER : TITLE_CELL_ROW_HOVER,
                className,
            )}
        >
            {children}
        </span>
    );
}
