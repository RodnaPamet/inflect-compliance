import { redirect } from 'next/navigation';

/**
 * `/admin/mcp/agent-receipts` compatibility shim — AGENTIC UI 1/4 (#2437).
 *
 * The mediator-signed receipt log moved to `/agents/receipts`. The export
 * endpoint it links each row to is unchanged at
 * `/api/t/:slug/agent-receipts/:id/export`.
 */
export default async function AgentReceiptsRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents/receipts`);
}
