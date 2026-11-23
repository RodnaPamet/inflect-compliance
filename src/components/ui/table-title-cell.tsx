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

import { cn } from '@inflect/ui/lib/cn';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';
import Link from 'next/link';
import {
    createContext,
    forwardRef,
    useContext,
    type HTMLAttributes,
    type MouseEvent,
    type ReactNode,
    type Ref,
} from 'react';

/**
 * Where a title cell is rendered, declared by the renderer that mounts it.
 *
 *   - `'table'` (default): a desktop table row. Nothing changes.
 *   - `'card'`: the TITLE of a phone card (`<DataTableCards>`) that does not
 *     open on a tap. The title is the card's way in, and as an inline link it
 *     was a 17-20px target a thumb missed, so it wears the shared touch hit
 *     area (44px on a coarse pointer, its own box everywhere else).
 *   - `'clickable-card'`: the title of a card that IS a button (`onRowClick`
 *     set). The card is the one target. A link or button inside it was an
 *     interactive element inside an interactive element: two tab stops, a
 *     nested control a screen reader announces inside the card's own name,
 *     and a 20px target on top of a 44px one doing something else. So the
 *     title renders as text with the same look, and a tap anywhere on the
 *     card does what the card does.
 */
export type TableTitleSurface = 'table' | 'card' | 'clickable-card';

const TableTitleSurfaceContext = createContext<TableTitleSurface>('table');

/** Set by `<DataTableCards>` around a card's title field. */
export const TableTitleSurfaceProvider = TableTitleSurfaceContext.Provider;

/** The surface the nearest title renderer declared (`'table'` outside one). */
export function useTableTitleSurface(): TableTitleSurface {
    return useContext(TableTitleSurfaceContext);
}

/**
 * The touch hit area a title link or button wears on a card. `inline-block`
 * so the positioned `::after` centres on ONE box even when a long title wraps
 * (an inline box split over lines has no single box to centre on); `relative`
 * because the pseudo-element positions against its owner.
 */
const CARD_TITLE_HIT_AREA = cn('relative inline-block max-w-full', TOUCH_HIT_AREA_CLASS);

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
    /** Forwarded as `data-testid` to the underlying Link / span. */
    testId?: string;
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
    testId,
    tintOn = 'row',
    className,
}: TableTitleCellProps) {
    const surface = useTableTitleSurface();
    if (href && surface !== 'clickable-card') {
        return (
            <Link
                href={href}
                id={id}
                data-testid={testId}
                className={cn(
                    TITLE_CELL_BASE,
                    TITLE_CELL_LINK_HOVER,
                    surface === 'card' && CARD_TITLE_HIT_AREA,
                    className,
                )}
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
            data-testid={testId}
            className={cn(
                TITLE_CELL_BASE,
                // A link title on a clickable card is text: the card carries
                // the hover, so the name does not pretend to be a link.
                !href && (tintOn === 'self' ? TITLE_CELL_LINK_HOVER : TITLE_CELL_ROW_HOVER),
                className,
            )}
        >
            {children}
        </span>
    );
}

export interface TableTitleButtonProps
    extends Omit<HTMLAttributes<HTMLElement>, 'onClick' | 'children' | 'className'> {
    /** The title text. */
    children: ReactNode;
    /** What the title does on its own: a quick-view, a side panel. */
    onClick: (e: MouseEvent<HTMLButtonElement>) => void;
    /** Forwarded as `data-testid` to the button (or, on a clickable card, the span). */
    testId?: string;
}

/**
 * A title that opens something in place (a quick-view panel) instead of
 * navigating: the button Controls, Tasks and Assets wrap their title in. It
 * stops the click, so the row's own handlers (select, open the full page) do
 * not fire with it.
 *
 * On a clickable phone card it renders as text, as `<TableTitleCell>` does:
 * the card is the one target there (see `TableTitleSurface`). On a card that
 * does not open on a tap it keeps its action and wears the touch hit area.
 *
 * Forwards its ref and any other props (a `<Tooltip>` trigger's handlers).
 */
export const TableTitleButton = forwardRef<HTMLElement, TableTitleButtonProps>(
    function TableTitleButton({ children, onClick, testId, ...rest }, ref) {
        const surface = useTableTitleSurface();
        if (surface === 'clickable-card') {
            return (
                <span ref={ref} data-testid={testId} {...rest}>
                    {/* `tintOn="row"`: a card has no `group/row`, so the name
                        does not tint like a link; the card carries the hover. */}
                    <TableTitleCell tintOn="row">{children}</TableTitleCell>
                </span>
            );
        }
        return (
            <button
                ref={ref as Ref<HTMLButtonElement>}
                type="button"
                data-testid={testId}
                {...rest}
                onClick={(e) => {
                    e.stopPropagation();
                    onClick(e);
                }}
                // `inline-block max-w-full` (NOT `block w-full`): the trigger's
                // footprint hugs the NAME, not the whole cell, as the title
                // links on Risks and Policies do. `truncate` keeps a long name
                // on one line in a table; a card wraps the name in full, and an
                // `overflow: hidden` owner would clip its hit area away.
                className={cn(
                    'inline-block max-w-full cursor-pointer text-left align-middle rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    surface === 'card' ? CARD_TITLE_HIT_AREA : 'truncate',
                )}
            >
                <TableTitleCell tintOn="self">{children}</TableTitleCell>
            </button>
        );
    },
);
