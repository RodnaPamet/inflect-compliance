'use client';

/**
 * RQ4-4 — Back affordance primitive.
 *
 * The thin "← Back to <Destination>" row that renders above the page
 * title on every subpage. Two-tier resolution:
 *
 *   1. Referrer (smart) — the in-tenant pathname the user just navigated
 *      from, read from per-tab sessionStorage via `usePreviousPath` (RQ4-3).
 *   2. Canonical fallback — when no referrer is available (cold load,
 *      deep link, fresh tab), the IA-canonical parent from
 *      `resolveCanonicalParent` (RQ4-4).
 *
 * The primitive ALWAYS resolves — there is no "no back affordance"
 * branch once the page mounts. OB-D: a deep-linked subpage still shows
 * "Back to <Section>".
 *
 * `<PageHeader>` accepts `back={{ smart: true }}` to mount this primitive,
 * keeping the existing static `{ href, label }` form working unchanged.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { ArrowLeft } from '@/components/ui/icons/nucleo';
import {
    usePreviousPath,
    tenantSlugFromPath,
} from '@/lib/nav/usePreviousPath';
import {
    resolveCanonicalParent,
    type CanonicalParent,
} from '@/lib/nav/canonical-parents';
import { resolveBackDestination } from '@/lib/nav/back-destination';

type CommonTranslate = ReturnType<typeof useTranslations<'common'>>;

/**
 * Map of in-tenant section paths to their `common.sections.*` message
 * key. `buildSectionLabels` resolves each through next-intl so the
 * referrer-based affordance shows the localised product name (e.g.
 * `/audits` → "Internal Audit" / "Вътрешен одит", not the raw
 * "Audits") without forcing every section to be listed.
 */
const SECTION_LABELS: Record<string, string> = {
    '/access-reviews': 'accessReviews',
    '/admin': 'admin',
    '/assets': 'assets',
    '/audits': 'audits',
    '/calendar': 'calendar',
    '/clauses': 'clauses',
    '/controls': 'controls',
    '/coverage': 'coverage',
    '/dashboard': 'dashboard',
    '/evidence': 'evidence',
    '/findings': 'findings',
    '/frameworks': 'frameworks',
    '/issues': 'issues',
    '/mapping': 'mapping',
    '/notifications': 'notifications',
    '/policies': 'policies',
    '/processes': 'processes',
    '/reports': 'reports',
    '/risks': 'risks',
    '/tasks': 'tasks',
    '/tests': 'tests',
    '/vendors': 'vendors',
};

/**
 * Resolve the `SECTION_LABELS` path → message-key map into a path →
 * localised-label map for the active locale.
 */
function buildSectionLabels(t: CommonTranslate): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, key] of Object.entries(SECTION_LABELS)) {
        out[path] = t(`sections.${key}`);
    }
    return out;
}

/**
 * Convert an in-tenant pathname back into a CanonicalParent shape by
 * looking up the label of the route the user came from. We don't have a
 * "label for any path" registry yet, so for now the smart label uses the
 * IA section name derived from the first segment.
 */
function labelFromPathname(
    pathname: string,
    sectionLabels: Record<string, string>,
    previousPageLabel: string,
): string {
    const stripped = pathname.replace(/^\/t\/[^/]+/, '');
    const seg = stripped.split('/').filter(Boolean)[0];
    if (!seg) return previousPageLabel;
    const sectionKey = `/${seg}`;
    if (sectionLabels[sectionKey]) return sectionLabels[sectionKey];
    return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export interface BackAffordanceProps {
    /** Optional override — used by tests + the `back` prop's static form. */
    override?: CanonicalParent;
    /**
     * When true, render ONLY when an in-tab referrer exists. With no
     * referrer (cold load, deep link, fresh tab), the component
     * returns null — no canonical-parent fallback.
     *
     * Use this variant on MAIN pages that are sometimes deep-linked
     * FROM elsewhere (e.g. `/clauses`, `/findings` reached from
     * `/audits`). The OB-H invariant — "no MAIN page renders an
     * IA-canonical back fallback" — stays intact; only the
     * "where you came from" arm remains.
     */
    noFallback?: boolean;
}

export function BackAffordance({ override, noFallback }: BackAffordanceProps) {
    const t = useTranslations('common');
    const sectionLabels = buildSectionLabels(t);
    const pathname = usePathname() ?? '';
    const tenantSlug = tenantSlugFromPath(pathname);
    const referrer = usePreviousPath(tenantSlug);

    const destination = resolveBackDestination({
        pathname,
        referrer,
        tenantSlug,
        override,
        noFallback,
        labelFor: (p) =>
            labelFromPathname(p, sectionLabels, t('ui.previousPage')),
    });

    if (!destination) return null;

    return (
        <Link
            href={destination.href}
            className="inline-flex items-center gap-1 text-content-muted text-xs hover:text-content-emphasis motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out print:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-default rounded-sm"
            data-testid="page-header-back"
            aria-label={t('ui.backTo', { label: destination.label })}
        >
            <ArrowLeft
                aria-hidden="true"
                className="h-3.5 w-3.5"
            />
            <span>{t('ui.backTo', { label: destination.label })}</span>
        </Link>
    );
}
