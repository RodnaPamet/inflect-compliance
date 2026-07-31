import { redirect } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { hasFeatureForTenant } from '@/lib/entitlements-server';
import { FEATURES } from '@/lib/entitlements';
import { getSoA } from '@/app-layer/usecases/soa';
import { SoAPrintView } from './SoAPrintView';

export const dynamic = 'force-dynamic';

/**
 * Print-optimized SoA page — no nav, clean layout, CSS print styles.
 * Users click "Print / Save as PDF" in their browser.
 */
export default async function SoAPrintPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ framework?: string }>;
}) {
    const { tenantSlug } = await params;
    // Honor the framework forwarded by the SoA "Print" affordance.
    const { framework } = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // ─── Gates ───
    //
    // This page had neither. `getTenantCtx` establishes only that the caller is
    // a member of the tenant, so any user — READER included — could open the
    // print view and hit window.print() for a full Statement of Applicability
    // PDF. That is the same artefact `reports/pdf/generate` gates on
    // reports.export AND the PDF_EXPORTS entitlement, reachable by URL.
    //
    // Redirecting rather than throwing: this is a page, not an API. A user who
    // lands here without the grant should end up somewhere useful, and the hub
    // already renders the Print affordance conditionally, so arriving here
    // unentitled means the URL was typed or shared.
    if (!ctx.appPermissions.reports.export) {
        redirect(`/t/${tenantSlug}/reports`);
    }
    if (!(await hasFeatureForTenant(ctx.tenantId, FEATURES.PDF_EXPORTS))) {
        redirect(`/t/${tenantSlug}/reports`);
    }

    // Independent fetches — run in parallel
    const [report, tenant] = await Promise.all([
        getSoA(ctx, {
            framework,
            includeEvidence: true,
            includeTasks: true,
            includeTests: true,
        }),
        import('@/lib/prisma').then(m =>
            m.default.tenant.findUnique({
                where: { id: ctx.tenantId },
                select: { name: true },
            })
        ),
    ]);

    // Same ISO-only guard as the interactive SoA page — the print view is a
    // Statement of Applicability, which a non-ISO framework doesn't have.
    if (!report.isIsoFamily) {
        redirect(`/t/${tenantSlug}/reports`);
    }

    return (
        <SoAPrintView
            report={JSON.parse(JSON.stringify(report))}
            tenantName={tenant?.name || tenantSlug}
            backHref={`/t/${tenantSlug}/reports`}
        />
    );
}
