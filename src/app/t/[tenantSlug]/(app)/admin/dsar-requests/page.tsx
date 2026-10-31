import { getTranslations } from 'next-intl/server';

import { listDsarRequests } from '@/app-layer/usecases/dsar-register';
import { DSAR_REGISTER_CAP } from '@/lib/dsar';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { DsarRegisterClient } from './DsarRegisterClient';

export const dynamic = 'force-dynamic';

/**
 * DSAR register — GDPR Art. 15 / 17 rights requests.
 *
 * This is a RECORD, not an engine. Fulfilment is manual: no export bundle is
 * produced and no data is erased by anything on this page. See
 * `usecases/dsar-register.ts` for the (load-bearing) tenant-scoping note.
 *
 * `canManage` is passed separately from read access because AUDITOR holds
 * `compliance_dsar_view` but not `_manage` — an auditor reads the register as
 * compliance evidence and never advances a request through it.
 *
 * Gated here, before the read (`admin.view` + `admin.compliance_dsar_view`):
 * the admin layout is a client component and cannot keep the register out of
 * the payload. An AUDITOR, who lacks `admin.view`, is therefore refused here as
 * the layout refuses them on screen. See `../_lib/admin-page-requirements.ts`.
 */
export default async function AdminDsarRequestsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/dsar-requests', params);
    if (!gate.allowed) return gate.forbidden;
    const { ctx, tenantSlug } = gate;
    const all = await listDsarRequests(ctx);
    // The usecase reads one past the cap: more than the cap means there are more.
    const truncated = all.length > DSAR_REGISTER_CAP;
    const requests = all.slice(0, DSAR_REGISTER_CAP);
    const t = await getTranslations('admin');

    return (
        <DsarRegisterClient
            tenantSlug={tenantSlug}
            initial={JSON.parse(JSON.stringify(requests))}
            canManage={Boolean(ctx.appPermissions?.admin?.compliance_dsar_manage)}
            truncated={truncated}
            title={t('dsar.title')}
        />
    );
}
