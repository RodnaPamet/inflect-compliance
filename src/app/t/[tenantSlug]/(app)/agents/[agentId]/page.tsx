import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/auth';
import { getTenantCtx } from '@/app-layer/context';
import { getRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { agentProfilesOn } from '@/app-layer/usecases/agent-profiles';
import { getInteractiveAgentDesignation } from '@/app-layer/usecases/interactive-agent-designation';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { listVendors } from '@/app-layer/usecases/vendor';
import { NotFoundError } from '@/lib/errors/types';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';
import {
    agentRegisterAffordances,
    edgeAdmitsAgentAdminWrite,
} from '@/lib/agentic/agent-register-affordances';
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

    // The INVENTORY read (#3710): the view key, or the register key whose
    // holders always could (`mayReadAgentInventory`). Refused here, before the
    // MetaStrip renders, because the header is the sensitive part — it carries
    // the autonomy rung, the data scope, the reversibility and both risk tiers
    // — and refusing after rendering it is not refusing. `getRegisteredAgent`
    // asserts the same read, so this is the friendly half of a gate the usecase
    // also holds.
    if (!mayReadAgentInventory(ctx.appPermissions.admin)) {
        const tf = await getTranslations('admin');
        return (
            <ForbiddenPage
                title={tf('agentDetail.forbiddenTitle')}
                message={tf('agentDetail.forbiddenMessage')}
            />
        );
    }

    // Resolved here rather than in the client so a bad id is a 404 from the
    // server, not a flash of chrome around an error panel.
    //
    // try/catch rather than `.catch(() => null)` — the same shape every other
    // detail page in this repo uses, and the arrow form trips the i18n
    // adoption ratchet's JSX_TEXT heuristic, which reads the `>` of `=>` and
    // the `<` of the component tag as a run of hardcoded UI text.
    //
    // Narrowed to NotFoundError. A bare catch rendered every failure as a
    // missing agent: the usecase asserts before it reads, so a permission
    // refusal and a decryption failure both arrived here as "no such agent" —
    // a refusal wearing the costume of a missing record, which is the one
    // diagnosis that stops the reader looking further. Anything that is not a
    // genuine 404 is re-thrown to the route error boundary, which logs it
    // under its own message.
    let agent: Awaited<ReturnType<typeof getRegisteredAgent>>;
    try {
        agent = await getRegisteredAgent(ctx, agentId);
    } catch (err) {
        if (err instanceof NotFoundError) notFound();
        throw err;
    }

    // The amend form's two reference lists (#2447), resolved here for the same
    // reason the register resolves them: `listAssignableUsers` is ACTIVE-only by
    // construction, which is exactly the population the usecase will accept as
    // an owner. A picker offering a name the server rejects is a form that lies
    // about what it can do.
    //
    // Best-effort, and separately: a reader who may amend the agent but not list
    // vendors still gets the form, with the supplier field disabled rather than
    // the whole page failing.
    const [owners, vendors, session, interactiveAgentId] = await Promise.all([
        listAssignableUsers(ctx).catch(() => []),
        listVendors(ctx, {}, { take: 200 }).catch(() => []),
        auth(),
        // Which agent answers on Ask (#4629). Best-effort: a failed read shows
        // no badge and offers "Use for Ask", which is the safe direction.
        getInteractiveAgentDesignation(ctx).catch(() => null),
    ]);

    // The register writes this reader is offered, asked of the same three
    // gates every one of them passes — the edge, the route's register key and
    // the usecase's agent-governance floor — through the functions the server
    // itself calls (#4471). It used to AND the key with the coarse
    // `canWrite` / `canAdmin`, which the floor replaced in #3699: the built-in
    // AI admin, whose coarse tier is READER's, could register an agent and was
    // then offered no way to score, activate, suspend, retire or amend it.
    const edgeAdmits = edgeAdmitsAgentAdminWrite(tenantSlug, session?.user);
    const registry = agentRegisterAffordances(ctx, edgeAdmits);

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
                // The amendable fields the header strip does not show. Threaded
                // so the amend form opens on the agent's REAL current values
                // rather than blanks the operator has to re-type — an edit form
                // that starts empty is a form that silently proposes clearing
                // everything it does not show.
                description: agent.description ?? null,
                modelRef: agent.modelRef ?? null,
                ownerUserId: agent.ownerUserId,
                vendorId: agent.vendorId ?? null,
                registrationEnforced: agent.registrationEnforced,
                isInteractiveAgent: interactiveAgentId === agent.id,
            }}
            owners={owners.map((m: { id: string; name: string | null; email: string }) => ({
                id: m.id,
                label: m.name ?? m.email,
            }))}
            vendors={vendors.map((v: { id: string; name: string }) => ({ id: v.id, name: v.name }))}
            // Resolved on the SERVER and threaded down rather than read per
            // tab: the shell has to decide which tabs are even reachable
            // before a tab mounts, and six tabs each re-deriving the same four
            // booleans is six chances to derive one of them differently.
            perms={{
                // The register key itself (#3710). The page needs only the
                // inventory read; the risk, skills, coverage and breaker tabs
                // and the tool-manifest pins read under this key, so a reader
                // holding only the view key (AUDITOR) gets them disabled rather
                // than opened and refused.
                canReadRegistry: ctx.appPermissions.admin.agent_registry,
                // Amend, activate, suspend, retire, and answer or complete
                // the risk assessment: the edge, `admin.agent_registry`, and
                // `assertAgentGovernanceWrite(ctx, 'agent_registry')` — the
                // coarse write tier OR the register key — as each of those
                // usecases asserts it.
                canManageRegistry: registry.canManage,
                canEditPolicyCard: ctx.appPermissions.admin.agent_policy_card,
                canGrantTools: ctx.appPermissions.admin.agent_tool_exposure,
                canKill: ctx.appPermissions.admin.agent_kill_switch,
                // Closing a breaker: the same three gates with
                // `assertAgentGovernanceAdmin` as the floor, which
                // `closeAgentCircuitBreaker` asserts.
                canCloseBreaker: registry.canAdminister,
                // The kill-switch history on the breaker tab reads the kill
                // switch's own list route: its key, behind the same edge. It
                // used to borrow `canCloseBreaker`, a different route's gate.
                canReadKillHistory: ctx.appPermissions.admin.agent_kill_switch === true && edgeAdmits,
                // The key alone, plus the read every agent floor keeps: the
                // tenant-skill usecases assert exactly `canRead` and
                // `admin.agent_skill_review` (#3680), so this flag renders the
                // authoring controls for exactly the people they work for.
                canReviewSkills:
                    ctx.appPermissions.admin.agent_skill_review === true && ctx.permissions.canRead,
                // The authoring half (#3778), asserted the same way by the
                // authoring usecases.
                canAuthorSkills:
                    ctx.appPermissions.admin.agent_skill_author === true && ctx.permissions.canRead,
                // The transfer routes' key and the read the usecase asserts
                // (#3807). Not ANDed with a role: `ctx.role` is a custom
                // role's BASE, and the edge reads the MEMBERSHIP role, so an
                // ADMIN membership on a READER-based custom role — a valid
                // recipient — would be hidden by it.
                canTransferOwnership:
                    ctx.appPermissions.admin.agent_ownership === true && ctx.permissions.canRead,
                // The Runs tab's read, `GET /agent-runs`, takes the runs page's
                // gate rather than this page's inventory read.
                canReadRuns: mayReadAgentActivity(ctx.appPermissions.admin),
                // The connect wizard's mint (#4155) is the api-keys route:
                // `requirePermission('admin.manage')`, then `createApiKey`'s
                // role-tier `assertCanAdmin`. Both halves, for the reason
                // `canCloseBreaker` gives above.
                canMintKeys: ctx.appPermissions.admin.manage && ctx.permissions.canAdmin,
            }}
            viewerUserId={ctx.userId}
            // The Behaviour tab exists only where agent profiles are on: the
            // whole deployment, this tenant by name, or its organization's
            // choice (Steps 1b and 1H, #4557). Its routes answer 404 everywhere
            // else.
            profilesEnabled={await agentProfilesOn(tenantSlug)}
        />
    );
}
