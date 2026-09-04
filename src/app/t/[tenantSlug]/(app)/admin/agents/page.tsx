import { getTenantCtx } from '@/app-layer/context';
import { listRegisteredAgents } from '@/app-layer/usecases/agent-registry';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { listVendors } from '@/app-layer/usecases/vendor';
import { AgentsClient, type AgentRow } from './AgentsClient';
import type { OwnerOption, VendorOption } from './NewAgentModal';

export const dynamic = 'force-dynamic';

/**
 * The agent register — Server Component. A sibling of `/admin/mcp`: that page is
 * the human-in-the-loop surface for what agents PROPOSE, this one is the record
 * of which agents may act at all.
 *
 * The owner picker is fed from ACTIVE memberships only, because the usecase
 * refuses anything else — offering a name the server will reject is a form that
 * lies. The vendor list is fed for the same reason on the third-party branch.
 */
export default async function AgentRegisterPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    const [agents, members, vendors] = await Promise.all([
        listRegisteredAgents(ctx),
        listAssignableUsers(ctx),
        listVendors(ctx, {}, { take: 200 }),
    ]);

    // `listAssignableUsers`, not `listTenantMembers`: it is ACTIVE-only by
    // construction, which is exactly the population the usecase will accept as
    // an owner. Offering a name the server is going to reject is a form that
    // lies about what it can do.
    const owners: OwnerOption[] = members.map((m) => ({
        id: m.id,
        label: m.name ?? m.email,
    }));

    const vendorOptions: VendorOption[] = vendors.map((v: { id: string; name: string }) => ({
        id: v.id,
        name: v.name,
    }));

    return (
        <AgentsClient
            initialRows={JSON.parse(JSON.stringify(agents)) as AgentRow[]}
            tenantSlug={resolved.tenantSlug}
            owners={owners}
            vendors={vendorOptions}
            canWrite={Boolean(ctx.appPermissions?.admin?.agent_registry)}
        />
    );
}
