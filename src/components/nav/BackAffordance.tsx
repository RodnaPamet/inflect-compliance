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
import { ArrowLeft } from '@inflect/ui/components/ui/icons/glyphs';
import {
    usePreviousPath,
    tenantSlugFromPath,
} from '@/lib/nav/usePreviousPath';
import {
    resolveCanonicalParent,
    SECTION_LABEL_KEYS,
    type BackLabelKey,
} from '@/lib/nav/canonical-parents';
import {
    resolveBackDestination,
    type BackDestination,
} from '@/lib/nav/back-destination';

type CommonTranslate = ReturnType<typeof useTranslations<'common'>>;

/**
 * Resolve the `SECTION_LABEL_KEYS` path → message-key map into a path →
 * localised-label map for the active locale.
 */
function buildSectionLabels(t: CommonTranslate): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [path, key] of Object.entries(SECTION_LABEL_KEYS)) {
        out[path] = t(`sections.${key}`);
    }
    return out;
}

/**
 * The label for a referrer-derived destination: the IA section name of the
 * route the user came from, derived from its first segment. A section with no
 * entry reads "previous page" — never the raw URL segment, which is English on
 * a Bulgarian page ("Обратно към Onboarding").
 */
function labelFromPathname(
    pathname: string,
    sectionLabels: Record<string, string>,
    previousPageLabel: string,
): string {
    const stripped = pathname.replace(/^\/t\/[^/]+/, '');
    const seg = stripped.split('/').filter(Boolean)[0];
    if (!seg) return previousPageLabel;
    return sectionLabels[`/${seg}`] ?? previousPageLabel;
}

export interface BackAffordanceProps {
    /** Optional override — used by tests + the `back` prop's static form. */
    override?: BackDestination;
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
        labelForKey: (key: BackLabelKey) => t(key),
    });

    if (!destination) return null;

    return (
        <Link
            href={destination.href}
            // `pointer-coarse:min-h-11` — on a phone this is the way out of
            // the page, so it gets a 44 px row (WCAG 2.5.5) rather than the
            // 16 px line a mouse is happy with. Height, not width: the label
            // is always wider than 44 px.
            className="inline-flex items-center gap-1 text-content-muted text-xs hover:text-content-emphasis motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out print:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-default rounded-sm pointer-coarse:min-h-11"
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
