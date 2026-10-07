/**
 * ListPageShell — viewport-fit layout for list pages.
 *
 * Wraps the standard "page header + filter toolbar + table card +
 * pagination footer" arrangement so the table card fills the
 * remaining viewport height and only the table body scrolls — the
 * page header, filters, and pagination footer stay anchored.
 *
 * On mobile (<md) the shell is a no-op: it falls back to natural
 * document flow so touch scrolling behaves the way the user expects.
 *
 * Usage:
 *
 *   <ListPageShell>
 *     <ListPageShell.Header>
 *       <h1>Risks</h1>
 *       <p>{count} risks identified</p>
 *     </ListPageShell.Header>
 *     <ListPageShell.Filters>
 *       <FilterToolbar ... />
 *     </ListPageShell.Filters>
 *     <ListPageShell.Body>
 *       <DataTable fillBody data={...} columns={...} />
 *     </ListPageShell.Body>
 *   </ListPageShell>
 *
 * Slots are optional and order-independent — only `Body` should
 * carry the table that should fill remaining height.
 *
 * Layout invariants the shell guarantees on md+:
 *   • The shell itself is `flex-1 min-h-0` inside its parent (the
 *     AppShell inner content div). It fills the available height.
 *   • Body is `flex-1 min-h-0 overflow-hidden` so its content
 *     (typically `<DataTable fillBody>`) provides its own internal
 *     scroll without the body itself scrolling.
 *   • Header, Filters, Footer are `flex-shrink-0` so they keep
 *     their natural height — the body shrinks to fill the rest.
 *
 * Why slots and not just children: future-proofing for sticky-on-
 * scroll states (e.g. "show subtitle only when scrolled into table
 * body") and for the Phase 3 ratchet that will check that pages
 * use the shell. Open to dropping the slots if they remain unused
 * after a release.
 */
import { ReactNode } from 'react';
import { cn } from '@inflect/ui/lib/cn';

export interface ListPageShellProps {
    children: ReactNode;
    className?: string;
}

export interface ListPageShellBodyProps extends ListPageShellProps {
    /**
     * Right-rail roadmap Phase 2 — optional aside slot. When provided,
     * the body becomes a flex row at `xl`+ : the main content
     * (`flex-1`) on the left, the aside column on the right, each with
     * its own scroll. Below `xl` the aside stacks under the main
     * content. Pass an `<AsidePanel>` here — it owns its own width
     * (320px expanded / 44px collapsed-to-spine) and degrades to a
     * `<Sheet>` below `xl`. Omit it and the body is the prior
     * single-column shape, byte-for-byte — existing pages are
     * untouched.
     */
    aside?: ReactNode;
    /**
     * B7 — optional left orientation rail. Pass a
     * `<LeftAccordionRail>` here. The body becomes a three-column
     * flex row at `xl`+ : left rail (~240px) · main content
     * (`flex-1`, table) · optional aside. Below `xl` the rail
     * stacks above the main content. The rail sits OUTSIDE the
     * table card's natural border via `gap-section` separation —
     * the layout reads as "rail · table · rail", not "rail
     * embedded INSIDE table".
     */
    leftRail?: ReactNode;
}

function ListPageShellRoot({ children, className }: ListPageShellProps) {
    return (
        <div
            className={cn(
                // Mobile: natural document flow, no flex constraints.
                // Desktop: flex column that fills its parent and lets
                // children flex-1 to claim remaining height.
                'flex flex-col gap-default',
                'md:flex-1 md:min-h-0',
                className,
            )}
            data-list-page-shell="true"
        >
            {children}
        </div>
    );
}

function ListPageShellHeader({ children, className }: ListPageShellProps) {
    return (
        <header className={cn('flex-shrink-0', className)}>
            {children}
        </header>
    );
}

function ListPageShellFilters({ children, className }: ListPageShellProps) {
    return (
        <div className={cn('flex-shrink-0', className)}>
            {children}
        </div>
    );
}

function ListPageShellBody({
    children,
    className,
    aside,
    leftRail,
}: ListPageShellBodyProps) {
    // No aside, no left rail — the prior single-column body,
    // unchanged. The `data-list-page-body` marker stays on this
    // div: DataTable's whole-row clip useEffect walks up to find
    // it and uses ITS clientHeight as the viewport allocation.
    if (!aside && !leftRail) {
        return (
            <div
                className={cn(
                    'md:flex-1 md:min-h-0 md:flex md:flex-col md:overflow-hidden',
                    className,
                )}
                data-list-page-body="true"
            >
                {children}
            </div>
        );
    }

    // One or both rails — a flex row at `xl`+ : optional left
    // rail, main column (flex-1), optional aside. Below `xl` the
    // rails stack (rail first, main second, aside third).
    //
    // `gap-section` between the columns is intentional — the rails
    // sit OUTSIDE the table card's natural border with a generous
    // breathing space; pre-B7 the gap was `gap-default` which made
    // the rail read "embedded into the table area". The left rail
    // is `xl:self-start` so it tracks the top of the body, not the
    // table's full height.
    return (
        <div className="md:flex-1 md:min-h-0 md:flex md:flex-col xl:flex-row md:overflow-hidden gap-section">
            {leftRail && (
                <aside
                    className="flex-shrink-0 xl:self-start"
                    aria-label="Orientation"
                    data-testid="list-page-left-rail"
                >
                    {leftRail}
                </aside>
            )}
            <div
                className={cn(
                    'md:flex-1 md:min-h-0 md:flex md:flex-col md:overflow-hidden xl:min-w-0',
                    className,
                )}
                data-list-page-body="true"
            >
                {children}
            </div>
            {aside && (
                <aside
                    // Stretch to the body height (not `self-start` → content
                    // height) + `min-h-0` so a tall docked panel (e.g. the
                    // editable quick-view) is CAPPED to the viewport and its
                    // own `overflow-y-auto` content scrolls, instead of the
                    // panel growing past the fold and getting clipped.
                    className="flex-shrink-0 xl:self-stretch xl:min-h-0"
                    aria-label="Context"
                    data-testid="list-page-aside"
                >
                    {aside}
                </aside>
            )}
        </div>
    );
}

function ListPageShellFooter({ children, className }: ListPageShellProps) {
    return (
        <footer className={cn('flex-shrink-0', className)}>
            {children}
        </footer>
    );
}

export const ListPageShell = Object.assign(ListPageShellRoot, {
    Header: ListPageShellHeader,
    Filters: ListPageShellFilters,
    Body: ListPageShellBody,
    Footer: ListPageShellFooter,
});
