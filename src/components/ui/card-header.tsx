'use client';

/**
 * `<CardHeader>` — Roadmap-3 PR-5.
 *
 * The single canonical card-heading rhythm across the product.
 * Until this PR, every card with a heading hand-rolled the
 * eyebrow / title / description / action stack — different
 * heading levels, different `mb-N` values, different action
 * placements. The user reads the inconsistency without knowing
 * why the rhythm "moves".
 *
 * Composition (top → bottom inside the header column):
 *
 *   1. eyebrow      — small uppercase label naming the card.
 *                      Optional. Use to type-classify the card
 *                      ("Section · Linkage", "Audit · Frozen").
 *   2. title        — `<Heading level={3}>` (default). The
 *                      visible card title; the load-bearing
 *                      identifier of the card.
 *   3. description  — muted body copy below the title. One
 *                      sentence ≤ 80 chars, declarative.
 *
 * Right cluster (next to the header):
 *
 *   4. actions      — small action cluster (overflow menu,
 *                      refresh, close). Optional.
 *
 * Spacing rhythm (locked):
 *
 *   • eyebrow → title       → 4 px (`mb-1` on Eyebrow)
 *   • title   → description → 4 px (`mt-1` on Caption)
 *   • header  → body        → 16 px (`mb-default` on header
 *                              wrapper). The PARENT card sets
 *                              this gap, not the header itself —
 *                              consumers compose:
 *                                <Card>
 *                                  <CardHeader … />
 *                                  <div className="mt-default">…body…</div>
 *                                </Card>
 *
 * Why `<Heading level={3}>` not `level={2}`:
 *   The page itself owns `level={1}` via `<PageHeader>`. Cards
 *   live inside pages; `level={2}` is reserved for major page
 *   sections. Cards therefore start at `level={3}`. This keeps
 *   the document outline coherent for screen readers.
 *
 * What this primitive is NOT:
 *   • Not a card SHELL — `<Card>` / `glass-card` is the
 *     container. `<CardHeader>` is the header that lives inside.
 *   • Not a content wrapper — it owns ONLY the heading row.
 */
import { type ReactNode } from 'react';
import { cn } from '@inflect/ui/lib/cn';
import { Caption, Eyebrow, Heading } from '@/components/ui/typography';

export interface CardHeaderProps {
    /** Small uppercase label above the title. */
    eyebrow?: ReactNode;
    /** The card title. Default heading level: 3. */
    title: ReactNode;
    /** Override the default heading level (rare — keep 3 unless
     *  the card sits at section depth 1 or 2). */
    titleLevel?: 1 | 2 | 3;
    /** Optional muted helper sentence below the title. */
    description?: ReactNode;
    /** Right-aligned action cluster (overflow menu, refresh, etc.). */
    actions?: ReactNode;
    /** Layout overrides on the outer wrapper. */
    className?: string;
    /** Forwarded to the outer element (E2E selectors). */
    'data-testid'?: string;
}

export function CardHeader({
    eyebrow,
    title,
    titleLevel = 3,
    description,
    actions,
    className,
    'data-testid': dataTestId,
}: CardHeaderProps) {
    return (
        <header
            className={cn(
                'flex items-start justify-between gap-default flex-wrap',
                className,
            )}
            data-testid={dataTestId ?? 'card-header'}
        >
            <div className="min-w-0">
                {eyebrow && (
                    <Eyebrow data-testid="card-header-eyebrow">
                        {eyebrow}
                    </Eyebrow>
                )}
                <Heading
                    level={titleLevel}
                    className={cn(
                        'text-content-emphasis',
                        eyebrow && 'mt-1',
                    )}
                    data-testid="card-header-title"
                >
                    {title}
                </Heading>
                {description !== undefined && description !== null && (
                    <Caption
                        className="mt-1"
                        data-testid="card-header-description"
                    >
                        {description}
                    </Caption>
                )}
            </div>
            {actions && (
                <div
                    className="flex items-center gap-tight shrink-0"
                    data-testid="card-header-actions"
                >
                    {actions}
                </div>
            )}
        </header>
    );
}
