import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listIntegrationConnections } from '@/app-layer/usecases/integrations';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { TARGET_POPULATIONS, targetPopulationKeys } from '@/app-layer/usecases/external-tool-target-populations';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ParameterSetsClient } from './ParameterSetsClient';

/**
 * SAVED PARAMETERS — the operator surface for an external tool's saved
 * arguments and the approval a change to one needs (#3124).
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * `ExternalToolParameterSet` shipped with four HTTP verbs, five usecases and a
 * database trigger enforcing four eyes, and nothing in the product called any of
 * it. The route landed in #2906 and had no caller since, so an operator could
 * not create a parameter set, propose an edit to one, sign one or approve one at
 * all — every path ran through a hand-made request from somebody holding both a
 * session and `admin.agent_registry`.
 *
 * It is the THIRD time that shape shipped in this subsystem. #2921 landed the
 * external-tool approval API with no UI; #2861 landed the external-write ladder
 * route with no UI. The ladder page's own docstring states the lesson: "A control
 * reachable only by curl is a column with governance prose attached."
 *
 * ── WHY UNDER `/agents` AND REACHED FROM THE TOOL CATALOGUE ─────────────────
 *
 * The question a set answers is about an AGENT's authority — what the agent
 * actually sends to somebody else's system — so it belongs with the rest of
 * agent governance rather than under `/admin`. Its inbound link is on the
 * external-tool catalogue page rather than in the Views menu, for the same
 * reason the external-write ladder's is: a parameter set is scoped to a TOOL ON
 * A CONNECTION, and the catalogue is where an operator already has that
 * connection selected. `canonical-parents.ts` names the same target, so Back and
 * the link cannot disagree.
 *
 * ── THE GATE IS THE REGISTER KEY, LIKE EVERY SIBLING ───────────────────────
 *
 * `admin.agent_registry`, matching the API routes this page drives. A set is
 * keyed by (tenant, tool, label) and NOT by agent, so editing one changes what
 * every agent granted that tool will send — the tenant-wide class, which is why
 * the route argues for the register key rather than the per-agent grant key.
 * Note what that means: NO API KEY CAN REACH THIS. `scopesToPermissions`
 * subtracts the agent-governance flags from even a `*` credential, so saving and
 * approving a set are acts a person performs in a session.
 *
 * ── WHAT IS READ HERE RATHER THAN IN THE CLIENT ────────────────────────────
 *
 * The CONNECTIONS, so the page renders with its picker already populated — an
 * empty picker that fills in a moment later reads as "you have no tool servers",
 * a different and wrong claim.
 *
 * The TARGET POPULATIONS, because the registry is a server module: it imports
 * `runInTenantContext`, so a client value-import would drag the database layer
 * into a page bundle (and `no-usecase-imports-in-client` refuses it). Passing the
 * key, the description and the BOUND as data keeps the one authoritative list in
 * one place — a hand-copied union in the client is how a page keeps offering a
 * population a deploy has removed.
 */
export default async function ParameterSetsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    if (!ctx.appPermissions?.admin?.agent_registry) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('register.accessTitle')}
                message={t('register.accessMessage')}
            />
        );
    }

    const connections = await listIntegrationConnections(ctx);
    const mcpConnections = connections
        .filter((c) => c.provider === MCP_SERVER_PROVIDER_ID && c.isEnabled)
        .map((c) => ({ id: c.id, name: c.name }));

    const targetPopulations = targetPopulationKeys().map((key) => ({
        key,
        description: TARGET_POPULATIONS[key].description,
        bound: TARGET_POPULATIONS[key].bound,
    }));

    // ONE value, and only when it is a single string. A repeated query parameter
    // arrives as an array, and taking its first member would pick a connection
    // the operator did not name — the client already falls back to the first
    // connection when the id does not match one it was given.
    const query = await searchParams;
    const requested = typeof query.connectionId === 'string' ? query.connectionId : null;

    return (
        <ParameterSetsClient
            connections={mcpConnections}
            targetPopulations={targetPopulations}
            initialConnectionId={requested}
        />
    );
}
