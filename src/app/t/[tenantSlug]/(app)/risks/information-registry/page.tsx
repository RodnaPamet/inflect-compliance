import { getTenantCtx } from '@/app-layer/context';
import { listInformationRegister } from '@/app-layer/usecases/vendor';
import { InformationRegistryClient, type RegisterRow } from './InformationRegistryClient';

export const dynamic = 'force-dynamic';

/**
 * DORA Register of Information (Art. 28(3)) — Server Component. A subpage
 * of Risks, shelved beside the EU AI Act registry under the Views menu's
 * "Registry" heading: both are regulatory registers ABOUT the estate
 * rather than analytics over it.
 *
 * The register is a PROJECTION of the vendor inventory, not a second
 * store — see the client for what that does and does not cover.
 */
export default async function InformationRegistryPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);
    const register = await listInformationRegister(ctx);

    return (
        <InformationRegistryClient
            rows={JSON.parse(JSON.stringify(register.rows)) as RegisterRow[]}
            truncated={register.truncated}
            total={register.total}
            criticalOrImportant={register.criticalOrImportant}
            canWrite={ctx.permissions.canWrite}
        />
    );
}
