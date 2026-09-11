import { redirect } from 'next/navigation';

/**
 * `/agent-runs` compatibility shim — AGENTIC UI 1/4 (#2437).
 *
 * Orchestrator observability moved under the register, at `/agents/runs`. The
 * API stays at `/api/t/:slug/agent-runs/*`.
 */
export default async function AgentRunsRedirect({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    redirect(`/t/${tenantSlug}/agents/runs`);
}
