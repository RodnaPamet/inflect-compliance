import { getTenantCtx } from '@/app-layer/context';
import { listTenantFrameworkUpdateViews } from '@/app-layer/usecases/framework-delta';

import { FrameworkUpdatesClient } from './FrameworkUpdatesClient';

/**
 * Framework updates (Epic Regwatch 2A). When a framework version lands in the
 * library, each affected tenant sees EXACTLY what changed and their new gap:
 * added requirements (new gaps), changed requirements (controls flagged for
 * re-review), removed requirements — plus actions.
 */
export default async function FrameworkUpdatesPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    // #4736 — names, titles, the changelog and the flagged controls, read
    // in bounded batches by the usecase.
    const rows = await listTenantFrameworkUpdateViews(ctx);
    const canWrite = ctx.permissions.canWrite;

    return <FrameworkUpdatesClient tenantSlug={tenantSlug} initialDeltas={rows} canWrite={canWrite} />;
}
