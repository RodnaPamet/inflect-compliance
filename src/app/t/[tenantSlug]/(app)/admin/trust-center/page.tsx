import { getTrustCenter } from '@/app-layer/usecases/trust-center';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { TrustCenterAdminClient } from './TrustCenterAdminClient';

export const dynamic = 'force-dynamic';

/**
 * Trust Center admin (compose) — Server Component. Authenticated + admin-gated.
 * Loads the curated row and passes the OWNER publish-capability flag so the
 * client only shows the publish toggle to OWNERs.
 *
 * The admin gate is applied HERE, before the read (`admin.view` +
 * `admin.manage`, the key `GET /admin/trust-center` holds): the admin layout is
 * a client component and cannot keep the row out of the payload. See
 * `../_lib/admin-page-requirements.ts`.
 */
export default async function TrustCenterAdminPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/trust-center', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;
    const trustCenter = await getTrustCenter(ctx);

    return (
        <TrustCenterAdminClient
            tenantSlug={tenantSlug}
            initial={trustCenter ? JSON.parse(JSON.stringify(trustCenter)) : null}
            canPublish={Boolean(ctx.appPermissions?.admin?.tenant_lifecycle)}
        />
    );
}
