"use client";

/**
 * `<PageHeader>` — single canonical page-header primitive (v2-PR-5).
 *
 * Replaces the hand-rolled header blocks across the layout shells:
 * `<EntityListPage header>` and `<EntityDetailLayout>` both consumed
 * to spell out the same flex/wrap/breadcrumbs/title/actions structure
 * with subtly different copy (e.g. `count` vs `description`). One
 * primitive, one composition recipe, one set of test ids.
 *
 * Composition slots (top → bottom inside the title column):
 *
 *   1. breadcrumbs   — Roadmap-2 PR-2 LIFTED these out of the page
 *                       header into the persistent top chrome. The
 *                       prop is still accepted for backward
 *                       compatibility — `useBreadcrumbs` pushes the
 *                       items into the shell-scoped context that
 *                       `<TopChrome>` consumes.
 *   2. back          — `← Label` text link rendered above the
 *                       title. Optional.
 *   3. eyebrow       — small uppercase label above the title (e.g.
 *                       resource name). Optional.
 *   4. title         — `<Heading level={1}>` (required).
 *   5. description   — muted body copy below the title. One sentence,
 *                       ≤ 80 chars. Optional.
 *   6. meta          — horizontal row of badges / chips below the
 *                       description (or title if no description).
 *                       Optional.
 *
 * Right cluster: `actions` — typically a single primary `<Button>`
 * + 1 secondary + 1 overflow menu.
 *
 * Render contract:
 *   - `<header>` element with `flex items-start justify-between
 *     gap-default flex-wrap`.
 *   - Title column (`min-w-0`) carries the breadcrumbs/back/eyebrow/
 *     title/description/meta stack.
 *   - Actions cluster wraps its children in `flex gap-tight flex-wrap`.
 *   - Stable test ids per slot so consumers can target them
 *     consistently in E2E tests.
 *
 * Pairs with:
 *   - `EntityListPage` and `EntityDetailLayout` adopt this primitive
 *     internally (they used to spell the structure inline).
 *   - Application pages that aren't list/detail shells (admin,
 *     dashboards, auth) can — and should — adopt this primitive
 *     directly in subsequent PRs.
 *
 * Why this is one primitive across both shells:
 *   - Identical visual rhythm (typography ratio, spacing, action
 *     cluster placement).
 *   - One place to land "every page header gets a quiet eyebrow"
 *     when v2-PR-12 (List header trio) lands.
 *   - One ratchet target — `<Heading level={1}>` outside the
 *     primitive becomes an architectural smell.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { classifyRoute } from "@/lib/nav/page-segregation";
import {
    Breadcrumbs,
    type BreadcrumbItem,
} from "@/components/ui/breadcrumbs";
import { useBreadcrumbs } from "@/components/layout/breadcrumbs-store";
import { PageActions } from "@/components/layout/PageActions";
import { BackAffordance } from "@/components/nav/BackAffordance";
import {
    Caption,
    Eyebrow,
    Heading,
} from "@/components/ui/typography";

export interface PageHeaderBackLink {
    href: string;
    label: string;
}

/**
 * RQ4-4 — Smart-back form. Mounts the `<BackAffordance>` primitive
 * instead of the static link. Resolves the destination in two tiers:
 *
 *   1. In-tab referrer (the page the user navigated FROM).
 *   2. IA-canonical parent (cold load / deep link / fresh tab).
 *
 * The legacy `{ href, label }` static form keeps working unchanged —
 * pages that want an explicit destination pass it as-is.
 */
export interface PageHeaderSmartBack {
    smart: true;
}

export type PageHeaderBack = PageHeaderBackLink | PageHeaderSmartBack;

export interface PageHeaderProps {
    /**
     * Breadcrumb trail rendered ABOVE the title. When supplied, prefer
     * this over `back` for deep navigation contexts. Both can co-
     * exist — breadcrumbs convey ancestor depth, back is a one-tap
     * affordance.
     */
    breadcrumbs?: ReadonlyArray<BreadcrumbItem>;
    /**
     * Back-navigation affordance rendered above the title. Two forms:
     *
     *   - `{ href, label }` — static link (legacy, still supported).
     *   - `{ smart: true }` — RQ4-4 smart back affordance: routes
     *     through `<BackAffordance>`, which resolves referrer first,
     *     canonical parent second. This is the default form every
     *     subpage should use.
     */
    back?: PageHeaderBack;
    /** Small uppercase eyebrow rendered above the title. */
    eyebrow?: React.ReactNode;
    /** Required `<Heading level={1}>` content. */
    title: React.ReactNode;
    /** Optional DOM id placed on the title <Heading> element (E2E anchor). */
    titleId?: string;
    /**
     * Small interactive cluster rendered as a SIBLING of the title
     * <Heading>, on the same baseline — today the detail-page prev/next
     * stepper.
     *
     * A sibling, deliberately, rather than something the caller folds into
     * `title`. Anything inside `title` lands inside the `<h1>`, and per the
     * accname spec a control's `aria-label` there is concatenated into the
     * HEADING's accessible name: a screen reader announces the page title as
     * "Ransomware on the billing cluster Previous incident Next incident".
     * jsdom will not catch a regression here — `dom-accessibility-api`
     * knowingly deviates from the spec for descendant controls (see its
     * `skipToStep2E` / accname issue 64 comment), so testing-library computes
     * the bare title and passes. Real browsers concatenate; Chromium's AX
     * tree was the thing that showed it.
     */
    titleAdornment?: React.ReactNode;
    /**
     * Optional descriptive sentence below the title. One sentence,
     * ≤ 80 chars per the v2 polish copy convention.
     */
    description?: React.ReactNode;
    /**
     * Horizontal row of meta badges / chips below the description
     * (or title if no description).
     */
    meta?: React.ReactNode;
    /** Right-aligned actions (button cluster, overflow menu). */
    actions?: React.ReactNode;
    /**
     * Layout overrides forwarded to the `<PageActions>` wrapper around the
     * actions cluster. Use for a page whose action row is wide enough to wrap
     * onto its own header line (a single wrapped flex item lands left under the
     * header's `justify-between`) — pass `ml-auto` to keep it right-aligned.
     */
    actionsClassName?: string;
    /** Layout overrides on the outer `<header>` element. */
    className?: string;
    /** Forwarded to the outer `<header>` element. */
    "data-testid"?: string;
}

export function PageHeader({
    breadcrumbs,
    back,
    eyebrow,
    title,
    titleId,
    titleAdornment,
    description,
    meta,
    actions,
    actionsClassName,
    className,
    "data-testid": dataTestId,
}: PageHeaderProps) {
    // Roadmap-2 PR-2 — breadcrumbs are ALSO pushed into the
    // shell-scoped context that `<TopChrome>` consumes, so they
    // render in the persistent top chrome on desktop. The local
    // render below is kept for two reasons:
    //   1. Mobile (<md): the top chrome is hidden — the in-page
    //      breadcrumbs are the user's wayfinding cue.
    //   2. Backward compatibility: rendered tests and existing
    //      `data-testid="page-header-breadcrumbs"` E2E selectors
    //      keep working unchanged.
    // On desktop the local breadcrumbs render is hidden via the
    // `md:hidden` class on its wrapper so we don't show two
    // breadcrumb trails at once.
    useBreadcrumbs(breadcrumbs);

    // Subtitle-led headers apply to MAIN pages only (top-level nav
    // destinations): the H1 is kept in the DOM as the a11y landmark but
    // visually hidden so the page leads with its subtitle. SUBPAGES
    // (detail / admin / nested) keep a visible H1 — the classification is
    // the repo's own MAIN vs SUBPAGE source of truth (page-segregation).
    const pathname = usePathname();
    const titleHidden = classifyRoute(pathname ?? "") === "main";

    return (
        <header
            className={cn(
                "flex items-start justify-between gap-default flex-wrap",
                className,
            )}
            data-testid={dataTestId}
        >
            <div className="min-w-0">
                {breadcrumbs && breadcrumbs.length > 0 && (
                    <div className="md:hidden">
                        <Breadcrumbs
                            items={breadcrumbs}
                            className="mb-1"
                            data-testid="page-header-breadcrumbs"
                        />
                    </div>
                )}
                {back && 'smart' in back ? (
                    <BackAffordance />
                ) : back ? (
                    <Link
                        href={back.href}
                        className="text-content-muted text-xs hover:text-content-emphasis transition-colors duration-150 ease-out"
                        data-testid="page-header-back"
                    >
                        ← {back.label}
                    </Link>
                ) : null}
                {eyebrow && (
                    <Eyebrow data-testid="page-header-eyebrow">
                        {eyebrow}
                    </Eyebrow>
                )}
                {/* MAIN pages: the H1 is kept in the DOM as the a11y landmark
                    but visually hidden (`sr-only`) so the page leads with its
                    subtitle, not a large H1. SUBPAGES keep a visible H1 —
                    removing it outright would strip the landmark + break the
                    h1/page-header contract. See titleHidden above. */}
                {titleAdornment && !titleHidden ? (
                    // Flex row, not a wrapper INSIDE the heading — see
                    // `titleAdornment`'s docstring for why that distinction
                    // is load-bearing. The heading's own top margin moves to
                    // the row so the baseline is unchanged.
                    <div
                        className={cn(
                            "flex items-center gap-2.5",
                            back && "mt-1",
                        )}
                        data-testid="page-header-title-row"
                    >
                        <Heading
                            level={1}
                            id={titleId}
                            data-testid="page-header-title"
                        >
                            {title}
                        </Heading>
                        {titleAdornment}
                    </div>
                ) : (
                    <Heading
                        level={1}
                        id={titleId}
                        className={titleHidden ? "sr-only" : cn(back && "mt-1")}
                        data-testid="page-header-title"
                    >
                        {title}
                    </Heading>
                )}
                {description !== undefined && description !== null && (
                    <Caption data-testid="page-header-description">
                        {description}
                    </Caption>
                )}
                {meta && (
                    <div
                        className="flex gap-tight mt-1 flex-wrap items-center"
                        data-testid="page-header-meta"
                    >
                        {meta}
                    </div>
                )}
            </div>
            {actions && (
                // Roadmap-3 PR-1 — the page-header action cluster
                // routes through `<PageActions>` so every page
                // header inherits the same right-aligned, gap-tight,
                // wrap-reverse cluster geometry. Pages don't need
                // to wrap their own actions — passing fragment
                // children to the slot is enough.
                <PageActions className={actionsClassName} data-testid="page-header-actions">
                    {actions}
                </PageActions>
            )}
        </header>
    );
}
