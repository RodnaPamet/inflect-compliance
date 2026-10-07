'use client';

/**
 * Epic 66 — `<CardList>` container.
 *
 * Responsive grid wrapper for card-based overview / summary
 * surfaces (health summaries, catalogue packs, member
 * directories, portfolio rollups). Pairs with `<CardList.Card>` +
 * the slot subcomponents in `card-list-card.tsx`.
 *
 * Layout contract:
 *   - 1 column on mobile (<sm)
 *   - 2 columns on tablet (sm–lg)
 *   - 3 columns on desktop (lg+)
 *   - Consistent `gap-default` between cards
 *   - Token-aligned: every visual is a `bg-*` / `border-*` / etc.
 *     class — no hex codes
 *
 * Selection state is owned by individual `<CardList.Card>`
 * instances (each carries its own `selected` + `onSelectChange`)
 * so the container stays content-agnostic. The bulk-action layer
 * — toolbar, "select all", count badge — is intentionally NOT in
 * the first iteration; pages that need it compose their own.
 *
 * The container exposes a context so descendant cards can read
 * the loading state and skip rendering interactive affordances
 * during fetch. When `loading` is true, the entire grid dims and
 * cards mark themselves `aria-busy`.
 */

import { cn } from '@inflect/ui/lib/cn';
import * as React from 'react';

// ─── Context ────────────────────────────────────────────────────────

interface CardListContextValue {
    loading: boolean;
}

export const CardListContext = React.createContext<CardListContextValue>({
    loading: false,
});

export function useCardListContext(): CardListContextValue {
    return React.useContext(CardListContext);
}

// ─── Props ──────────────────────────────────────────────────────────

export interface CardListProps {
    /**
     * Mark the entire grid as loading. Cards dim collectively and
     * set `aria-busy="true"`. Page-level skeletons / shimmer should
     * render INSIDE individual cards via the standard primitives.
     */
    loading?: boolean;
    /** Class on the wrapper. Override the responsive cols from here if needed. */
    className?: string;
    /** Children — typically a flat list of `<CardList.Card>` instances. */
    children?: React.ReactNode;
    /** Optional `data-testid` on the wrapper. */
    'data-testid'?: string;
    /** Override the accessible label. Defaults to omitted (let the page provide it). */
    'aria-label'?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export function CardList({
    loading = false,
    className,
    children,
    'data-testid': testId,
    'aria-label': ariaLabel,
}: CardListProps) {
    return (
        <ul
            role="list"
            aria-label={ariaLabel}
            aria-busy={loading || undefined}
            data-card-list
            data-testid={testId}
            className={cn(
                'grid w-full gap-default',
                'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
                loading && 'opacity-60',
                className,
            )}
        >
            <CardListContext.Provider value={{ loading }}>
                {children}
            </CardListContext.Provider>
        </ul>
    );
}
