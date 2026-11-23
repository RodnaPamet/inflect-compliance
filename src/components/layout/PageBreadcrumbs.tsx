'use client';

/**
 * `<PageBreadcrumbs>` — Roadmap-2 PR-13.
 *
 * The thin wrapper that puts every page's breadcrumb trail in the
 * persistent top chrome (PR-2) on desktop while preserving an
 * inline render on mobile (where the chrome is hidden by the
 * existing mobile top bar).
 *
 * Behaviour:
 *   • Pushes `items` into the shell-scoped `BreadcrumbsContext`
 *     via `useBreadcrumbs` — `<TopChrome>` consumes that and
 *     renders the trail on the desktop chrome.
 *   • Renders the same items via the canonical `<Breadcrumbs>`
 *     primitive wrapped in `md:hidden` — only the mobile shell
 *     surfaces this DOM, so the desktop user sees the chrome
 *     version and the mobile user sees the inline version.
 *
 * Why a tiny wrapper:
 *   `<PageHeader breadcrumbs={…}>` already does this, but many
 *   pages don't go through `<PageHeader>` — they hand-roll their
 *   own header with a direct `<Breadcrumbs>` mount. Without
 *   `<PageBreadcrumbs>` those pages render breadcrumbs ONLY in
 *   the page body and never reach the chrome. Replacing every
 *   inline `<Breadcrumbs items=…>` with `<PageBreadcrumbs items=…>`
 *   is a one-token swap that lifts the trail to the chrome
 *   immediately.
 *
 * What this is NOT:
 *   • Not a replacement for `<Breadcrumbs>` itself — the
 *     primitive stays the canonical render. `<PageBreadcrumbs>`
 *     is a page-level wrapper that adds the chrome push +
 *     viewport-conditional render.
 *   • Not a replacement for `<PageHeader>` — pages that already
 *     route through `<PageHeader breadcrumbs=…>` get the same
 *     behaviour for free; they don't need to swap.
 */
import {
    Breadcrumbs,
    type BreadcrumbItem,
} from '@/components/ui/breadcrumbs';
import { PHONE_TRAIL_CLASS, useBreadcrumbs } from './breadcrumbs-store';

export interface PageBreadcrumbsProps {
    items: ReadonlyArray<BreadcrumbItem>;
    /**
     * Forwarded to the inline (mobile) `<Breadcrumbs>` mount.
     * Default `mb-1` matches the spacing every page used to
     * apply directly.
     */
    className?: string;
    /** Forwarded to the underlying primitive (E2E selectors). */
    'data-testid'?: string;
}

export function PageBreadcrumbs({
    items,
    className = 'mb-1',
    'data-testid': dataTestId,
}: PageBreadcrumbsProps) {
    // Push to chrome — desktop renders here on first paint.
    useBreadcrumbs(items);

    // Mobile fallback. The chrome is `hidden md:flex`, so on <md
    // the user only sees this inline rendering. Wrapping in
    // `md:hidden` ensures desktop doesn't double-render the same
    // trail (chrome + page-body). And a phone hides it where a back link is
    // showing — one way back, in one place (`PHONE_TRAIL_CLASS`).
    return (
        <div className={`${PHONE_TRAIL_CLASS} ${className}`}>
            <Breadcrumbs items={items} data-testid={dataTestId} />
        </div>
    );
}
