/**
 * /t/[tenantSlug]/admin/risk-matrix — Epic 44.5
 *
 * Admin entry point for the tenant-scoped risk-matrix configuration.
 * Server component fetches the effective config (canonical default
 * for tenants who haven't customised) and hands it to a client
 * island for interactive editing. Permission is enforced two ways:
 *
 *   1. This page refuses, before the read, anybody without `admin.view` (the
 *      admin layout's rule) and `risks.view` (the key the config is read under
 *      at `/risk-matrix-config`). The parent `/admin/layout.tsx` is a CLIENT
 *      component: it hides the page on screen but runs after this server
 *      component has rendered, so it cannot keep the config out of the
 *      payload. See `../_lib/admin-page-requirements.ts`.
 *   2. The client's PUT request to `/api/t/:slug/admin/risk-matrix-config`
 *      is gated by `requirePermission('admin.manage')` server-side
 *      (see `src/lib/security/route-permissions.ts`).
 */

import { getRiskMatrixConfig } from '@/app-layer/usecases/risk-matrix-config';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { RiskMatrixAdminClient } from './RiskMatrixAdminClient';

export const dynamic = 'force-dynamic';

export default async function RiskMatrixAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/risk-matrix', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;
    const initialConfig = await getRiskMatrixConfig(ctx);

    return (
        <RiskMatrixAdminClient
            tenantSlug={tenantSlug}
            initialConfig={initialConfig}
        />
    );
}
