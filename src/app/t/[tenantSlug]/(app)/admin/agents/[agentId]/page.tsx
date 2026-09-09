import { notFound } from 'next/navigation';
import { getTenantCtx } from '@/app-layer/context';
import { getRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { AgentDetailClient } from './AgentDetailClient';

/**
 * `/t/:slug/admin/agents/:agentId` — the one place an agent's governing
 * surfaces are visible together.
 *
 * Before this page the register listed agents and stopped: the policy card,
 * the tool pins, the ASI coverage, the circuit breaker and the kill switch
 * were all reachable only by `curl`. Splitting them across six screens would
 * have repeated that mistake in a smaller way — the question an operator
 * actually asks is "what is this agent allowed to do, and is it currently
 * doing it", which is not answerable one endpoint at a time.
 */
export default async function AgentDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; agentId: string }>;
}) {
    const { tenantSlug, agentId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });

    // Resolved here rather than in the client so a bad id is a 404 from the
    // server, not a flash of chrome around an error panel.
    //
    // try/catch rather than `.catch(() => null)` — the same shape every other
    // detail page in this repo uses, and the arrow form trips the i18n
    // adoption ratchet's JSX_TEXT heuristic, which reads the `>` of `=>` and
    // the `<` of the component tag as a run of hardcoded UI text.
    let agent: Awaited<ReturnType<typeof getRegisteredAgent>>;
    try {
        agent = await getRegisteredAgent(ctx, agentId);
    } catch {
        notFound();
    }

    return (
        <AgentDetailClient
            tenantSlug={tenantSlug}
            agent={{
                id: agent.id,
                name: agent.name,
                status: agent.status,
                autonomyLevel: agent.autonomyLevel,
                dataAccessScope: agent.dataAccessScope,
                reversibility: agent.reversibility,
                provenance: agent.provenance,
                riskTier: agent.riskTier ?? null,
                aiActRiskTier: agent.aiSystem?.riskTier ?? null,
            }}
        />
    );
}
