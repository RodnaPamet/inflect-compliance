import { redirect } from 'next/navigation';

/**
 * `/admin/agents/:agentId` compatibility shim — AGENTIC UI 1/4 (#2427).
 *
 * The agent detail subtree moved to `/agents/:agentId` with the register. The
 * id is carried through so a bookmark to one agent still lands on that agent,
 * not on the list.
 */
export default async function AdminAgentDetailRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string; agentId: string }>;
}) {
    const { tenantSlug, agentId } = await params;
    redirect(`/t/${tenantSlug}/agents/${agentId}`);
}
