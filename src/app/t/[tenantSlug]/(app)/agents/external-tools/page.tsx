import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listIntegrationConnections } from '@/app-layer/usecases/integrations';
import { MCP_SERVER_PROVIDER_ID } from '@/app-layer/integrations/providers/mcp-server-provider';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ExternalToolsClient } from './ExternalToolsClient';

/**
 * EXTERNAL TOOLS — the operator surface for "what may an agent reach outside
 * this product, and who said so".
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * #2921 landed the API for approving an external tool's manifest and #2859 the
 * grant that makes one reachable. The provider's own header says a tool becomes
 * callable "only by being pinned into the tenant's manifest and GRANTED to an
 * agent, both of which are human acts" — and until this page there was no human
 * surface for either. The route existed, nothing called it, and the only way to
 * approve anything was a hand-written fetch in a browser console.
 *
 * That is worth stating plainly because it is the second time the same shape
 * shipped in this subsystem: `McpServerProvider` was written and never
 * registered, so the connection form could not create one. An API without its
 * operator path is not a feature, it is a feature's back half.
 *
 * ── IT BASELINES; THE TOOLS TAB GRANTS ──────────────────────────────────────
 *
 * Granting already has a surface — the agent detail page's Tools tab, which
 * shows each tool's required rung, marks an inert grant, offers revoke and
 * carries the register's re-assessment. This page deliberately does not
 * duplicate a thinner copy of it.
 *
 * The half with no surface is the BASELINE, and the ordering is the product's
 * own: `listAgentTools` builds the grant picker from the PIN TABLE, so an
 * external tool becomes grantable only once somebody has approved its
 * definition here. Approving on this page is what makes a tool appear there.
 *
 * ── WHY UNDER `/agents` AND NOT `/admin` ────────────────────────────────────
 *
 * The question this answers is about an AGENT's authority, so it belongs with
 * the rest of agent governance — the same reasoning that moved the register
 * here, and why `/admin/agents/:agentId` is now a redirect shim. It is reached
 * from the "Views ▾" menu alongside its siblings.
 *
 * ── THE GATE IS THE REGISTER KEY, DELIBERATELY ──────────────────────────────
 *
 * `admin.agent_registry`, matching the API routes this page drives and every
 * sibling under `/agents`. Note what that means and is meant to mean: NO API
 * KEY CAN REACH THIS. `scopesToPermissions` subtracts the four agent-governance
 * flags from even a `*` key, so approving a manifest and granting a tool are
 * acts a person performs in a session and a bearer token never performs at all.
 * A credential that could grant itself tools is the thing that subtraction
 * exists to prevent.
 */
export default async function ExternalToolsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
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

    // Read here rather than in the client so the page renders with its choices
    // already made — an empty connection picker that fills in a moment later
    // reads as "you have no tool servers", a different and wrong claim.
    const connections = await listIntegrationConnections(ctx);

    const mcpConnections = connections
        .filter((c) => c.provider === MCP_SERVER_PROVIDER_ID && c.isEnabled)
        .map((c) => ({ id: c.id, name: c.name, lastTestStatus: c.lastTestStatus ?? null }));


    return (
        <ExternalToolsClient
            tenantSlug={resolved.tenantSlug}
            connections={mcpConnections}
            canReviewProposals={Boolean(ctx.appPermissions?.admin?.view)}
            canInvestigate={Boolean(ctx.appPermissions?.admin?.agent_registry)}
        />
    );
}
