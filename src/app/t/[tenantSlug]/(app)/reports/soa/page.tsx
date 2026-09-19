import { redirect } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getSoA } from '@/app-layer/usecases/soa';
import { SoAClient } from './SoAClient';
import { BackAffordance } from '@/components/nav/BackAffordance';

export const dynamic = 'force-dynamic';

export default async function SoAPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ framework?: string }>;
}) {
    const { tenantSlug } = await params;
    // Honor the framework the user selected on the reports hub (the "Open SoA"
    // link forwards `?framework=<selectedKey>`). Absent → getSoA resolves the
    // first installed framework, as before.
    const { framework } = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    const report = await getSoA(ctx, {
        framework,
        includeEvidence: true,
        includeTasks: true,
        includeTests: true,
    });

    // The Statement of Applicability is an ISO-27001-Annex-A artifact — a non-ISO
    // framework has no SoA. Guard the standalone surface against direct-URL access
    // (the hub's SoA card is already ISO-gated) by sending them to the readiness hub.
    if (!report.hasStatementOfApplicability) {
        redirect(`/t/${tenantSlug}/reports`);
    }

    // Load tenant controls for the "Map control" modal
    const controls = await import('@/lib/prisma').then(m => m.default.control.findMany({
        where: { tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, code: true, name: true, status: true },
        orderBy: { code: 'asc' },
    }));

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <SoAClient
                report={JSON.parse(JSON.stringify(report))}
                controls={JSON.parse(JSON.stringify(controls))}
                tenantSlug={tenantSlug}
                canEdit={ctx.permissions.canWrite}
            />
        </div>
    );
}
