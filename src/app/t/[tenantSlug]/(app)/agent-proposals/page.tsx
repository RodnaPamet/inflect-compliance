import { redirect } from 'next/navigation';

/**
 * `/agent-proposals` compatibility shim — AGENTIC UI 1/4 (#2437).
 *
 * The propose-not-commit review queue moved under the register it belongs to,
 * at `/agents/proposals`. The API stays at `/api/t/:slug/agent-proposals/*`.
 */
export default async function AgentProposalsRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents/proposals`);
}
