import { listEmployees } from '@/app-layer/usecases/personnel';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { PersonnelClient, type EmployeeRow } from './PersonnelClient';

export const dynamic = 'force-dynamic';

/**
 * Personnel roster (PR-4) — Server Component. The people-layer hub. Lists
 * employees synced from an HRIS or entered manually.
 *
 * Gated here, before the read (`admin.view` + `personnel.view`): the admin
 * layout is a client component and cannot keep this page's rows out of the
 * payload. See `../_lib/admin-page-requirements.ts`.
 */
export default async function PersonnelPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
    const gate = await gateAdminPage('/admin/personnel', params);
    if (!gate.allowed) return gate.forbidden;
    const rows = (await listEmployees(gate.ctx)) as unknown as EmployeeRow[];
    return <PersonnelClient initialRows={JSON.parse(JSON.stringify(rows))} tenantSlug={gate.tenantSlug} />;
}
