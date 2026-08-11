import { getTenantCtx } from '@/app-layer/context';
import { Nis2GapLifecycleClient } from './Nis2GapLifecycleClient';

export const dynamic = 'force-dynamic';

/**
 * NIS2 Gap Assessment — lifecycle home (Audits sub-page).
 *
 * The ongoing layer on top of the onboarding wizard's one-time baseline run:
 * run history + trend, the latest run's per-domain maturity radar + prioritised
 * gaps, a "Re-run assessment" action, and a propose-not-commit remediation
 * review list. Built on the single DB-backed NISD2 question bank — no second
 * bank, no second assessment model. The client fetches its own state.
 */
export default async function Nis2GapPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const canWrite = ctx.permissions.canWrite;
    // The delegation panel is a SEPARATE capability from writing to the page.
    // Every endpoint behind it — list assignments, dispatch, finalize — is
    // `requirePermission('admin.manage')`, so it needs its own flag rather than
    // riding on `canWrite` (true for EDITOR, for whom `admin.manage` is false).
    const canManage = ctx.appPermissions.admin.manage;
    return (
        <Nis2GapLifecycleClient
            tenantSlug={tenantSlug}
            canWrite={canWrite}
            canManage={canManage}
        />
    );
}
