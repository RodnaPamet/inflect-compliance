import { listEmployees } from '@/app-layer/usecases/personnel';
import { gateAdminPage } from '../_lib/admin-page-gate';
import { PersonnelClient, type EmployeeRoster } from './PersonnelClient';
import { PERSONNEL_FILTER_KEYS } from './filter-defs';

export const dynamic = 'force-dynamic';

/**
 * Personnel roster (PR-4) — Server Component. The people-layer hub. Lists
 * the employees an HRIS sync has brought in (plus any created through the
 * API; this page only reads).
 *
 * Gated here, before the read (`admin.view` + `personnel.view`): the admin
 * layout is a client component and cannot keep this page's rows out of the
 * payload. See `../_lib/admin-page-requirements.ts`.
 *
 * The read here is always the WHOLE roster, so the header counts the roster
 * rather than a filtered view. A status filter or search in the address is
 * handed to the client only so its first render matches the server's; the
 * client asks the API for the filtered rows (#4470).
 */
export default async function PersonnelPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const gate = await gateAdminPage('/admin/personnel', params);
    if (!gate.allowed) return gate.forbidden;
    const roster = (await listEmployees(gate.ctx)) as unknown as EmployeeRoster;
    const sp = await searchParams;
    const initialFilters: Record<string, string> = {};
    for (const key of [...PERSONNEL_FILTER_KEYS, 'q']) {
        const value = sp[key];
        if (typeof value === 'string' && value) initialFilters[key] = value;
    }
    return (
        <PersonnelClient
            initialRoster={JSON.parse(JSON.stringify(roster))}
            initialFilters={initialFilters}
            tenantSlug={gate.tenantSlug}
        />
    );
}
