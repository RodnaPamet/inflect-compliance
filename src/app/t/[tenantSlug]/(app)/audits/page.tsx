import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAudits } from '@/app-layer/usecases/audit';
import { tenantHasNis2 } from '@/app-layer/usecases/nis2-gap-lifecycle';
import { AuditsClient } from './AuditsClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at SSR_PAGE_LIMIT rows so the initial HTML
// payload + DB query stay bounded as tenants accumulate audits.
// The Epic 69 SWR client immediately fetches the unbounded list
// in the background and keepPreviousData swaps it in transparently.
// Mirrors the PR #146 / #149 pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Audits — Server Component wrapper.
 * Fetches audits list server-side, delegates interactive master/detail to client island.
 */
export default async function AuditsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    // feat/audit-cycle-unify — the hub can scope to one cycle's fieldwork
    // audits via ?cycleId (GET /audits?cycleId already filters).
    const cycleId = typeof sp.cycleId === 'string' ? sp.cycleId : undefined;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('audits'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);
    // hasNis2 gates the "NIS2 Gap Assessment" entry button — installed = the
    // tenant has run the NIS2 gap self-assessment or has NIS2-mapped controls.
    const [audits, hasNis2] = await Promise.all([
        cycleId
            ? listAudits(ctx, { take: SSR_PAGE_LIMIT, auditCycleId: cycleId })
            : listAudits(ctx, { take: SSR_PAGE_LIMIT }),
        tenantHasNis2(ctx),
    ]);

    return (
        <div className="space-y-section animate-fadeIn">
            <AuditsClient
                initialAudits={JSON.parse(JSON.stringify(audits))}
                tenantSlug={tenantSlug}
                cycleId={cycleId}
                hasNis2={hasNis2}
                canWrite={ctx.permissions.canWrite}
                translations={{
                    title: t('title'),
                listDescription: t('listDescription'),
                    newAudit: t('newAudit'),
                    auditTitle: t('auditTitle'),
                    auditors: t('auditors'),
                    scope: t('scope'),
                    createAudit: t('createAudit'),
                    cancel: tc('cancel'),
                    planned: t('planned'),
                    inProgress: t('inProgress'),
                    completed: t('completed'),
                    cancelled: t('cancelled'),
                    notTested: t('notTested'),
                    pass: t('pass'),
                    fail: t('fail'),
                    checklist: t('checklist'),
                    findingsTab: t('findingsTab'),
                    selectAudit: t('selectAudit'),
                }}
            />
        </div>
    );
}
