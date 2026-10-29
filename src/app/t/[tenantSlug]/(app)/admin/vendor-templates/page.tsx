/**
 * Epic G-3 — vendor assessment template index (admin).
 *
 * Lists the latest version of each tenant template + a "+ New
 * template" action that creates a draft and redirects to the
 * builder.
 */
import { gateAdminPage } from '../_lib/admin-page-gate';
import { VendorTemplatesIndexClient } from './VendorTemplatesIndexClient';

export const dynamic = 'force-dynamic';

/** Reads nothing on the server; gated like every admin server page (`../_lib/admin-page-requirements.ts`). */
export default async function VendorTemplatesIndexPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const gate = await gateAdminPage('/admin/vendor-templates', params);
    if (!gate.allowed) return gate.forbidden;
    return <VendorTemplatesIndexClient />;
}
