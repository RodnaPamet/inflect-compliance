import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getBia } from '@/app-layer/usecases/business-impact-analysis';
import { BiaDetailClient, type BiaDetail } from './BiaDetailClient';

export const dynamic = 'force-dynamic';

/** Business Impact Analysis — detail (Server Component). */
export default async function BiaDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; id: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    let bia: BiaDetail;
    try {
        bia = (await getBia(ctx, resolved.id)) as unknown as BiaDetail;
    } catch {
        notFound();
    }
    return (
        <BiaDetailClient
            bia={bia}
            tenantSlug={resolved.tenantSlug}
            // The same flag as the register's create button: every write behind
            // this page takes `continuity.edit` and the write tier (#4632).
            canWrite={ctx.permissions.canWrite && ctx.appPermissions.continuity.edit}
        />
    );
}
