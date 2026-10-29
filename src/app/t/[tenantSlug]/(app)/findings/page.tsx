import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFindings } from '@/app-layer/usecases/finding';
import { FindingsClient } from './FindingsClient';
import { BackAffordance } from '@/components/nav/BackAffordance';

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
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('findings'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);
    const findings = await listFindings(ctx, { take: SSR_PAGE_LIMIT });

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance noFallback />
            <FindingsClient
                initialFindings={JSON.parse(JSON.stringify(findings))}
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
