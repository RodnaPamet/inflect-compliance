'use client';

/**
 * Epic 66 — `<CardList.Card>`, `<CardList.CardHeader>`, `<CardList.CardContent>`.
 *
 * Card primitives that compose with the responsive grid in
 * `card-list.tsx` to standardise overview / summary surfaces.
 *
 * Composition shape:
 *
 *   <CardList.Card
 *     selectable
 *     selected={picked}
 *     onSelectChange={setPicked}
 *     onClick={() => router.push(href)}
 *   >
 *     <CardList.CardHeader
 *       title="Acme Corp"
 *       badge={<StatusBadge variant="success">Active</StatusBadge>}
 *       actions={<DropdownMenu>...</DropdownMenu>}
 *     />
 *     <CardList.CardContent
 *       kv={[
 *         { label: 'Owner', value: 'ciso@acme.com' },
 *         { label: 'Coverage', value: '75%' },
 *       ]}
 *     >
 *       (free-form children render below the kv block)
 *     </CardList.CardContent>
 *   </CardList.Card>
 *
 * Accessibility:
 *   - The card mounts as `<li role="listitem">` so screen readers
 *     announce the cardinality (the parent grid is `role="list"`).
 *   - When `onClick` is set, the inner card surface becomes a
 *     `<button>`-equivalent via `role="button" tabIndex={0}` plus
 *     Space/Enter handlers. We keep the outer `<li>` non-focusable
 *     so the keyboard stop count matches the cardinality announced.
 *   - The selection checkbox lives in its own focus stop and stops
 *     `mousedown`/`click` propagation so picking it does NOT also
 *     trigger the card's `onClick` (a row-click + checkbox-click
 *     race that bites every selectable list).
 *   - Action menus inside the header carry the same propagation
 *     guard via the `data-card-action` marker and the inner
 *     `onClick` filter that ignores clicks originating inside one.
 */

import { cn } from '@/lib/cn';
import * as React from 'react';

import { useCardListContext } from './card-list';
import { Heading } from '@/components/ui/typography';

// ─── Card context ──────────────────────────────────────────────────

interface CardItemContextValue {
    /** True when this card has been selected via its checkbox. */
    selected: boolean;
}

const CardItemContext = React.createContext<CardItemContextValue>({
    selected: false,
});

export function useCardItemContext(): CardItemContextValue {
    return React.useContext(CardItemContext);
}

// ─── Card props ────────────────────────────────────────────────────

export interface CardListCardProps {
    /** Click handler — fires when the card body is clicked or activated by keyboard. */
    onClick?: (e: React.MouseEvent | React.KeyboardEvent) => void;
    /** Show a selection checkbox in the top-right. */
    selectable?: boolean;
    /** Controlled selection state. Required when `selectable` is true. */
    selected?: boolean;
    /** Called when the user toggles the selection checkbox. */
    onSelectChange?: (next: boolean) => void;
    /** Override the checkbox's accessible label. Defaults to "Select card". */
    selectionLabel?: string;
    /** Class on the outer `<li>`. */
    className?: string;
    /** Class on the inner card body (where slots render). */
    innerClassName?: string;
    /** Optional `data-testid` on the card. */
    'data-testid'?: string;
    /** Optional `aria-label` for the card body. */
    'aria-label'?: string;
    /** Slot content — typically `<CardList.CardHeader>` + `<CardList.CardContent>`. */
    children?: React.ReactNode;
}

// ─── Card ──────────────────────────────────────────────────────────

function isInteractiveTargetWithinCard(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    // The selection checkbox + any `data-card-action` (action-menu
    // triggers, badges that are themselves links) must NOT bubble
    // into the card-level click. Stop the propagation here rather
    // than at every call site.
    return (
        target.closest('[data-card-checkbox]') !== null ||
        target.closest('[data-card-action]') !== null ||
        target.closest('a, button') !== null
    );
}

export function CardListCard({
    onClick,
    selectable = false,
    selected = false,
    onSelectChange,
    selectionLabel = 'Select card',
    className,
    innerClassName,
    'data-testid': testId,
    'aria-label': ariaLabel,
    children,
}: CardListCardProps) {
    const { loading } = useCardListContext();
    const interactive = !!onClick;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.(e);
        }
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!interactive) return;
        if (isInteractiveTargetWithinCard(e.target)) return;
        onClick(e);
    };

    return (
        <li
            role="listitem"
            data-card-list-card
            data-testid={testId}
            data-selected={selected || undefined}
            className={cn(
                'group relative flex flex-col rounded-lg border border-border-subtle bg-bg-default',
                // v2-PR-4 — single motion language: bg + border-color
                // only, no transform/shadow. The hover affordance is
                // the border darkening (`hover:border-border-emphasis`)
                // — quiet, decisive, doesn't perturb layout.
                'transition-colors duration-150 ease-out',
                interactive &&
                    'cursor-pointer hover:border-border-emphasis',
                selected && 'ring-2 ring-[var(--brand-default)] border-[var(--brand-default)]',
                loading && 'pointer-events-none',
                className,
            )}
        >
            {selectable && (
                <label
                    data-card-checkbox
                    className={cn(
                        'absolute top-3 right-3 z-10 flex h-5 w-5 items-center justify-center',
                        'cursor-pointer rounded border border-border-default bg-bg-default',
                        'transition-colors hover:border-[var(--brand-default)]',
                        selected && 'border-[var(--brand-default)] bg-[var(--brand-default)]',
                    )}
                    onClick={(e) => e.stopPropagation()}
                >
                    <input
                        type="checkbox"
                        className="sr-only"
                        aria-label={selectionLabel}
                        checked={selected}
                        onChange={(e) => onSelectChange?.(e.target.checked)}
                    />
                    {selected && (
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            className="h-3 w-3 text-content-inverted"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                        >
                            <path d="M3 8l3.5 3.5L13 4.5" />
                        </svg>
                    )}
                </label>
            )}

            {/*
             * Inner click surface. When `onClick` is provided the
             * surface is keyboard-activatable; otherwise it stays
             * inert so non-interactive cards don't grab focus.
             */}
            <div
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                aria-label={ariaLabel}
                aria-busy={loading || undefined}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                className={cn(
                    'flex flex-1 flex-col p-4',
                    interactive &&
                        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-offset-2 rounded-lg',
                    innerClassName,
                )}
            >
                <CardItemContext.Provider value={{ selected }}>
                    {children}
                </CardItemContext.Provider>
            </div>
        </li>
    );
}

// ─── CardHeader ────────────────────────────────────────────────────

export interface CardListCardHeaderProps {
    /** Card title — short label, usually a name or identifier. */
    title: React.ReactNode;
    /** Optional badge (status pill, count chip, etc.). */
    badge?: React.ReactNode;
    /** Optional action menu / toolbar slot, e.g. a kebab dropdown. */
    actions?: React.ReactNode;
    /** Optional subtitle rendered under the title row. */
    subtitle?: React.ReactNode;
    /** Class on the wrapper. */
    className?: string;
}

export function CardListCardHeader({
    title,
    badge,
    actions,
    subtitle,
    className,
}: CardListCardHeaderProps) {
    return (
        <header
            data-card-header
            className={cn('mb-3 flex items-start justify-between gap-compact', className)}
        >
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-tight">
                    <Heading level={3} className="truncate">
                        {title}
                    </Heading>
                    {badge && (
                        <span data-card-header-badge className="shrink-0">
                            {badge}
                        </span>
                    )}
                </div>
                {subtitle && (
                    <p className="mt-0.5 truncate text-xs text-content-muted">
                        {subtitle}
                    </p>
                )}
            </div>
            {actions && (
                <span
                    data-card-action
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                >
                    {actions}
                </span>
            )}
        </header>
    );
}

// ─── CardContent ───────────────────────────────────────────────────

export interface CardKeyValue {
    label: React.ReactNode;
    value: React.ReactNode;
}

export interface CardListCardContentProps {
    /**
     * Optional structured key-value list rendered as a `<dl>`. Use
     * for the common "label : value" rows (Owner, Coverage, Last
     * updated, …). Rendered ABOVE any free-form `children`.
     */
    kv?: ReadonlyArray<CardKeyValue>;
    /** Class on the wrapper. */
    className?: string;
    /** Free-form body content. */
    children?: React.ReactNode;
}

export function CardListCardContent({
    kv,
    className,
    children,
}: CardListCardContentProps) {
    return (
        <div
            data-card-content
            className={cn('flex flex-1 flex-col gap-compact text-sm text-content-default', className)}
        >
            {kv && kv.length > 0 && (
                <dl
                    data-card-kv
                    className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs"
                >
                    {kv.map((row, i) => (
                        <React.Fragment key={i}>
                            <dt className="text-content-muted">{row.label}</dt>
                            <dd className="text-right text-content-emphasis tabular-nums">
                                {row.value}
                            </dd>
                        </React.Fragment>
                    ))}
                </dl>
            )}
            {children}
        </div>
    );
}
