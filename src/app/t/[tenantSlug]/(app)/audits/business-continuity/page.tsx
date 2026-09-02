import { getTenantCtx } from '@/app-layer/context';
import { listBias } from '@/app-layer/usecases/business-impact-analysis';
import { BusinessContinuityClient, type BiaRow } from './BusinessContinuityClient';

export const dynamic = 'force-dynamic';

/**
 * Business Continuity (BIA register) — Server Component. Sits under the
 * Internal Audit area beside Incidents. Lists Business Impact Analyses with
 * their derived recovery-priority rank and delegates filter + create to the
 * client island.
 */
export default async function BusinessContinuityPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const rows = (await listBias(ctx)) as unknown as BiaRow[];

    return (
        <BusinessContinuityClient
            initialRows={rows}
            tenantSlug={resolved.tenantSlug}
            // BOTH, not just the role tier. #2197 gave the BIA writes a
            // `continuity.edit` gate, so a custom role can now be built with
            // that flag off while `canWrite` stays true — and this button
            // would still render, then 403 on submit. Controls and Tasks
            // already read `appPermissions` for the same reason; these pages
            // did not, and the configuration that reaches it did not exist
            // before that gate.
            canWrite={ctx.permissions.canWrite && ctx.appPermissions.continuity.edit}
        />
    );
}
