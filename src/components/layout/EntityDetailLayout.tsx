"use client";

/**
 * `EntityDetailLayout` — reusable detail-page shell.
 *
 * Inflect's domain detail pages (controls, risks, policies, vendors,
 * audits, …) share a structural pattern even though their content
 * differs sharply: a back link, a title, a meta row of badges, a
 * right-side action area, an optional tab bar, and a content slot
 * that swaps based on the active tab. The shell extracts those
 * shared concerns into one component so future detail pages adopt
 * a consistent shape without a copy-paste header.
 *
 * What this is NOT:
 *
 *   - A JSON-driven generic "render any entity" meta-framework.
 *     Domain-specific panels (TraceabilityPanel, LinkedTasksPanel,
 *     TestPlansPanel, the controls-overview metadata grid, the
 *     risk inherent-vs-residual scorer) STAY in the page that
 *     owns them. The shell carries layout, not business content.
 *
 *   - A renderer that decides which tabs to show. The page provides
 *     the tab list + active tab + change handler; the shell paints
 *     them.
 *
 *   - A data fetcher. Pages run their own queries and pass the
 *     resulting `loading` / `error` / `empty` flags to the shell.
 *
 * Visual: stays inside the existing token vocabulary (no new colour
 * scales). Header layout matches the prior controls page. Tabs use
 * the same active-bar pattern (border-b accent + emphasis text).
 *
 * The same shell handles the "no tabs" case (simply omit the `tabs`
 * prop) — useful for risks-style pages that stack sections instead.
 */

import { type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cardVariants } from '@/components/ui/card';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { Button } from '@/components/ui/button';

import { cn } from '@/lib/cn';
import { type BreadcrumbItem } from '@/components/ui/breadcrumbs';
import { PageHeader } from '@/components/layout/PageHeader';

// ─── Tab descriptor ───────────────────────────────────────────────

export interface EntityDetailTab<TKey extends string = string> {
    /** Stable identifier for the tab. Drives `activeTab` matching. */
    key: TKey;
    /** Visible tab label. */
    label: string;
    /** Optional count badge (e.g. tasks count). Hidden when undefined. */
    count?: number;
    /** When true, the tab is disabled (greyed, not clickable). */
    disabled?: boolean;
}

// ─── Public props ────────────────────────────────────────────────

export interface EntityDetailLayoutProps<TKey extends string = string> {
    /**
     * Breadcrumb trail rendered ABOVE the title. When supplied, prefer
     * this over `back` — breadcrumbs convey ancestor depth that a single
     * back link can't. The two are not mutually exclusive: passing both
     * shows breadcrumbs above + the back link below them, but the
     * canonical pattern is to use one or the other.
     */
    breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
    /**
     * Back-navigation affordance rendered above the title. Two forms:
     *
     *   - `{ href, label }` — static link (legacy, still supported).
     *   - `{ smart: true }` — RQ4-4 smart back affordance: forwards to
     *     `<PageHeader>` which mounts `<BackAffordance>`, resolving the
     *     destination from the in-tab referrer (or canonical parent on
     *     a cold load / deep link).
     */
    back?:
        | { href: string; label: string }
        | { smart: true };
    /** Title of the detail page. Plain string OR rich element. */
    title: ReactNode;
    /**
     * Prev/next record stepper rendered INLINE beside the title.
     *
     * Pass this rather than hand-composing `<span className="inline-flex
     * items-center gap-2.5">{title}<EntityPrevNextNav/></span>` in the page.
     * The nav is going onto every entity detail page, and the one page that
     * hand-rolled it is also the page where it silently broke: its caller fed
     * the component an empty id list for two weeks and the arrows just never
     * rendered. One composition site is one place for that to go wrong.
     *
     * Ids must be in the order the LIST showed them — see `idsFromCappedList`
     * in `@/lib/list-backfill-cap` for reading them out of a list response.
     * The nav hides itself when there is nothing to step through, so passing a
     * short or empty list is safe.
     */
    prevNext?: {
        ids: ReadonlyArray<string>;
        currentId: string;
        hrefFor: (id: string) => string;
        labelSingular: string;
    };
    /**
     * Meta row beneath the title — typically a row of status badges
     * (status / applicability / sync state). Optional.
     */
    meta?: ReactNode;
    /**
     * Right-side action area in the header — typically status
     * combobox + primary action buttons. Optional.
     */
    actions?: ReactNode;

    // ── Lifecycle ─────────────────────────────────────────────────

    /**
     * When true, render the loading skeleton instead of the body.
     * The skeleton mirrors the eventual layout (header + tab bar +
     * content card) so the page doesn't visibly "jump" on load.
     */
    loading?: boolean;
    /**
     * Inline error rendered in place of the body. The shell intentionally
     * does NOT echo back arbitrary error JSON — the caller passes the
     * user-facing string.
     *
     * Pass an object with `onRetry` to render a retry affordance alongside
     * it. A load failure is usually transient (offline, a 500, an aborted
     * request), and a bare message leaves the operator with a dead end and
     * a browser reload as their only option. The plain-string form is
     * retained — most callers have nothing useful to retry.
     */
    error?: string | { message: string; onRetry?: () => void } | null;
    /**
     * Empty-state copy rendered when the entity wasn't found. Pass a
     * string for the default rendering or omit for "Not found.".
     */
    empty?: {
        message: string;
    } | null;

    // ── Tab bar ───────────────────────────────────────────────────

    /**
     * Tab list. Omit for pages that don't use tabs (the shell
     * renders children directly under the header).
     */
    tabs?: ReadonlyArray<EntityDetailTab<TKey>>;
    /** Currently selected tab key. Required when `tabs` is provided. */
    activeTab?: TKey;
    /** Tab-change handler. Required when `tabs` is provided. */
    onTabChange?: (tab: TKey) => void;

    // ── Body ─────────────────────────────────────────────────────

    /** Outer wrapper className override. */
    className?: string;
    /** Stable id forwarded to the outer container (for E2E selectors). */
    id?: string;
    /**
     * Page body. When tabs are configured this is the active tab's
     * content; the page typically conditionally renders based on
     * `activeTab`. When tabs are omitted, this is the entire body.
     */
    children: ReactNode;
    /**
     * Roadmap-2 PR-5 — opt-in master-detail right rail.
     *
     * When supplied AND the viewport is ≥ `xl` (1280px), the body
     * renders as a 2-column grid: main content 1fr, rail 320px,
     * gap-default between, both columns scrollable independently.
     * Below `xl` the rail collapses below the main column —
     * mobile and small desktops keep the current single-column
     * behaviour.
     *
     * Use this slot for content that ABOUT the entity but is not
     * the entity itself: linked tasks, recent activity, quick
     * actions, related entities. Anything the user would want
     * to act on without losing place inside the main content.
     *
     * Pages that don't need a rail simply don't pass it — the
     * shell falls back to the prior single-column shape and no
     * test or call site changes.
     */
    rail?: ReactNode;
}

// ─── Component ──────────────────────────────────────────────────

export function EntityDetailLayout<TKey extends string = string>({
    breadcrumbs,
    back,
    title,
    prevNext,
    meta,
    actions,
    loading,
    error,
    empty,
    tabs,
    activeTab,
    onTabChange,
    className,
    id,
    children,
    rail,
}: EntityDetailLayoutProps<TKey>) {
    const t = useTranslations('common');
    const retryLabel = t('retry');
    // v2-fu-4 — render the breadcrumbs / back link in EVERY state
    // (loading / error / empty / main). Previously the loading
    // skeleton, error block, and empty block returned early before
    // the PageHeader was rendered, leaving the user without any
    // navigation affordance for the duration of the data fetch.
    // The header is now always present; only the body changes.
    // The nav rides WITH the title through the same loading/error/empty
    // suppression below — otherwise the arrows flash beside an empty heading
    // while the entity is still loading.
    const titleNode =
        prevNext !== undefined ? (
            <span className="inline-flex items-center gap-2.5">
                {title}
                <EntityPrevNextNav
                    ids={prevNext.ids}
                    currentId={prevNext.currentId}
                    hrefFor={prevNext.hrefFor}
                    labelSingular={prevNext.labelSingular}
                />
            </span>
        ) : (
            title
        );
    const headerNode = (
        <PageHeader
            breadcrumbs={breadcrumbs}
            back={back}
            title={loading || error || empty ? '' : titleNode}
            meta={loading || error || empty ? undefined : meta}
            actions={loading || error || empty ? undefined : actions}
            data-testid="entity-detail-header"
        />
    );

    if (loading) {
        return (
            <div
                className={cn('space-y-section animate-fadeIn', className)}
                aria-busy="true"
                data-entity-detail-layout
                data-testid="entity-detail-loading"
            >
                {headerNode}
                <DetailLoadingSkeleton tabCount={tabs?.length ?? 4} />
            </div>
        );
    }
    if (error) {
        const errorMessage = typeof error === 'string' ? error : error.message;
        const onRetry = typeof error === 'string' ? undefined : error.onRetry;
        return (
            <div
                className={cn('space-y-section animate-fadeIn', className)}
                data-entity-detail-layout
            >
                {headerNode}
                <div
                    className="p-12 text-center text-content-error space-y-default"
                    role="alert"
                    data-testid="entity-detail-error"
                >
                    <p>{errorMessage}</p>
                    {onRetry && (
                        <Button
                            variant="secondary"
                            onClick={onRetry}
                            data-testid="entity-detail-retry"
                        >
                            {retryLabel}
                        </Button>
                    )}
                </div>
            </div>
        );
    }
    if (empty) {
        return (
            <div
                className={cn('space-y-section animate-fadeIn', className)}
                data-entity-detail-layout
            >
                {headerNode}
                <div
                    className="p-12 text-center text-content-subtle text-sm"
                    data-testid="entity-detail-empty"
                >
                    {empty.message}
                </div>
            </div>
        );
    }

    return (
        <div
            id={id}
            className={cn('space-y-section animate-fadeIn', className)}
            data-entity-detail-layout
        >
            {/* Header */}
            {headerNode}


            {/* Tab bar (optional) */}
            {tabs && tabs.length > 0 && (
                <nav
                    className="flex gap-1 border-b border-border-default overflow-x-auto"
                    role="tablist"
                    aria-label={t('table.detailSections')}
                    data-testid="entity-detail-tabs"
                >
                    {tabs.map((t) => {
                        const isActive = activeTab === t.key;
                        return (
                            <button
                                key={t.key}
                                type="button"
                                role="tab"
                                aria-selected={isActive}
                                aria-controls={`tabpanel-${t.key}`}
                                disabled={t.disabled}
                                className={cn(
                                    'px-4 py-2 text-sm font-medium transition border-b-2 whitespace-nowrap',
                                    isActive
                                        ? 'border-[var(--brand-default)] text-content-emphasis'
                                        : 'border-transparent text-content-muted hover:text-content-emphasis',
                                    t.disabled && 'opacity-50 cursor-not-allowed',
                                )}
                                onClick={() => {
                                    if (!t.disabled && onTabChange) onTabChange(t.key);
                                }}
                                data-testid={`tab-${t.key}`}
                                id={`tab-${t.key}`}
                            >
                                {t.label}
                                {t.count !== undefined && (
                                    <TabCount value={t.count} />
                                )}
                            </button>
                        );
                    })}
                </nav>
            )}

            {/* Body — wraps in a 2-column grid when a `rail` slot
                is provided (Roadmap-2 PR-5). The grid kicks in at
                `xl` (1280px); below that the rail stacks under the
                main column so phones/laptops keep the prior
                single-column shape.

                PR-12: every body container carries
                `space-y-section` so multiple sibling cards
                (risk-detail, traceability, treatment plan, …)
                breathe at the canonical 32px rhythm. Without it
                the cards rendered with zero vertical gap between
                them — pages that own multi-card stacks looked
                fused together. */}
            {rail ? (
                // Right-rail roadmap Phase 1 — a flex row, not a
                // fixed-track grid: the rail's width is owned by the
                // rail content (`<AsidePanel>` renders 320px expanded
                // or 44px collapsed), so collapsing the panel reflows
                // the main column with no shared state. Below xl the
                // row stacks; `<AsidePanel>` itself degrades to a
                // `<Sheet>` there.
                <div
                    className="flex flex-col gap-default xl:flex-row"
                    data-testid="entity-detail-rail-grid"
                >
                    {tabs && activeTab ? (
                        <div
                            role="tabpanel"
                            id={`tabpanel-${activeTab}`}
                            aria-labelledby={`tab-${activeTab}`}
                            data-testid="entity-detail-tabpanel"
                            className="min-w-0 xl:flex-1 space-y-section"
                        >
                            {children}
                        </div>
                    ) : (
                        <div
                            data-testid="entity-detail-body"
                            className="min-w-0 xl:flex-1 space-y-section"
                        >
                            {children}
                        </div>
                    )}
                    <aside
                        className="flex-shrink-0 space-y-default xl:sticky xl:top-20 xl:self-start"
                        aria-label={t('table.context')}
                        data-testid="entity-detail-rail"
                    >
                        {rail}
                    </aside>
                </div>
            ) : tabs && activeTab ? (
                <div
                    role="tabpanel"
                    id={`tabpanel-${activeTab}`}
                    aria-labelledby={`tab-${activeTab}`}
                    data-testid="entity-detail-tabpanel"
                    className="space-y-section"
                >
                    {children}
                </div>
            ) : (
                <div
                    data-testid="entity-detail-body"
                    className="space-y-section"
                >
                    {children}
                </div>
            )}
        </div>
    );
}

// ─── Tab count ────────────────────────────────────────────────────
//
// Roadmap-4 PR-7 — canonical tab-count rendering.
//
// Tab labels carry an optional count (e.g. "Tasks (12)") that
// communicates "how many things will I find under this tab". The
// rendering is centralised here for two reasons:
//
//   1. Visual consistency. The count sits one step weaker than the
//      label's tone — `text-xs` (vs `text-sm` on the label) plus
//      `opacity-60` so the count dims relative to whatever tone the
//      label inherited (selected = emphasis, unselected = muted).
//      The opacity-on-inherit trick is deliberate: a fixed
//      `text-content-subtle` would look the same regardless of
//      selection state, killing the active-tab affordance.
//
//   2. Digit-width stability. `tabular-nums` keeps every digit at
//      the same width, so a count that ticks 9 → 10 doesn't shift
//      the tab-bar layout sideways. The detail page no longer
//      twitches as live counts update in the background.
//
// New tab bars MUST mount this helper instead of hand-rolling the
// `({n})` shape — the ratchet at
// `tests/guards/tab-count-discipline.test.ts` enforces that and the
// class string above.

function TabCount({ value }: { value: number }) {
    return (
        <span
            className="ml-1 text-xs tabular-nums opacity-60"
            data-tab-count
        >
            ({value})
        </span>
    );
}

// ─── Loading skeleton ─────────────────────────────────────────────
//
// Pulled out so test code can mount it directly + so the shell
// doesn't grow JSX at the top of its render. The skeleton mirrors
// the layout: header + tab bar + content card.

function DetailLoadingSkeleton({ tabCount }: { tabCount: number }) {
    // v2-fu-4 — the surrounding wrapper + breadcrumbs/back link are
    // owned by the parent `<EntityDetailLayout>` so the skeleton can
    // focus on the body shape (title placeholder + tab strip + content
    // card). The header (breadcrumbs + back) renders unchanged in all
    // states, giving the user navigation affordance during the fetch.
    return (
        <>
            <div className="space-y-tight">
                <div className="animate-pulse rounded bg-bg-elevated/60 h-7 w-64" />
            </div>
            <div className="flex gap-1 border-b border-border-default">
                {Array.from({ length: tabCount }).map((_, i) => (
                    <div
                        key={i}
                        className="animate-pulse rounded bg-bg-elevated/60 h-8 w-20 mx-1"
                    />
                ))}
            </div>
            <div className={cn(cardVariants(), 'space-y-default')}>
                <div className="grid grid-cols-2 gap-section">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="space-y-1">
                            <div className="animate-pulse rounded bg-bg-elevated/60 h-3 w-16" />
                            <div className="animate-pulse rounded bg-bg-elevated/60 h-4 w-full" />
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}
