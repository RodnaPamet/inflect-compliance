import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFindings } from '@/app-layer/usecases/finding';
import { FindingsClient } from './FindingsClient';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { FINDING_STATUSES } from './filter-defs';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at SSR_PAGE_LIMIT rows so the initial HTML
// payload + DB query stay bounded as tenants accumulate findings.
// The Epic 69 SWR client immediately fetches the unbounded list
// in the background and keepPreviousData swaps it in transparently.
// Mirrors the PR #146 / #149 pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Findings — Server Component wrapper.
 * Fetches findings data server-side, delegates interactive table to client island.
 */
export default async function FindingsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    // The status facet, for the server-rendered first page. Members that are
    // not a finding status (a `?status=ACTIVE` carried over from another list)
    // are dropped here rather than failing the whole render; the client's own
    // fetch sends what the URL says and gets the API's 400 for a bad value.
    const rawStatus = typeof sp.status === 'string' ? sp.status : '';
    const status = rawStatus
        .split(',')
        .map((v) => v.trim())
        .filter((v): v is (typeof FINDING_STATUSES)[number] =>
            (FINDING_STATUSES as readonly string[]).includes(v),
        )
        .join(',');
    const initialFilters: Record<string, string> = status ? { status } : {};

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('findings'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);
    const findings = await listFindings(ctx, { take: SSR_PAGE_LIMIT }, { status: status || undefined });

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance noFallback />
            <FindingsClient
                initialFindings={JSON.parse(JSON.stringify(findings))}
                initialFilters={initialFilters}
                tenantSlug={tenantSlug}
                // `createFinding` / `updateFinding` assert the coarse write
                // tier only, so the UI offers writes on exactly that.
                canWrite={ctx.permissions.canWrite}
                translations={{
                    title: t('title'),
                listDescription: t('listDescription'),
                    open: t('open'),
                    newFinding: t('newFinding'),
                    findingTitle: t('findingTitle'),
                    severity: t('severity'),
                    type: t('type'),
                    owner: t('owner'),
                    status: t('status'),
                    description: t('description'),
                    dueDate: t('dueDate'),
                    createFinding: t('createFinding'),
                    noFindings: t('noFindings'),
                    low: t('low'),
                    medium: t('medium'),
                    high: t('high'),
                    critical: t('critical'),
                    nonconformity: t('nonconformity'),
                    observation: t('observation'),
                    opportunity: t('opportunity'),
                    inProgress: t('inProgress'),
                    readyForVerification: t('readyForVerification'),
                    closed: t('closed'),
                    cancel: tc('cancel'),
                    actions: tc('actions'),
                }}
            />
        </div>
    );
}
