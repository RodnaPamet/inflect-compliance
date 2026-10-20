import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { getRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { listVendors } from '@/app-layer/usecases/vendor';
import { NotFoundError } from '@/lib/errors/types';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentInventory } from '@/lib/permissions';
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
    const [owners, vendors] = await Promise.all([
        listAssignableUsers(ctx).catch(() => []),
        listVendors(ctx, {}, { take: 200 }).catch(() => []),
    ]);

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
            //
            // `canCloseBreaker` is the only conjunction, and it is not
            // cosmetic. Closing a breaker asserts the role-tier admin check on
            // top of the route's registry key, and that tier is computed from
            // the membership's BASE ROLE rather than the permissions blob — so
            // a custom role with an editor base can hold agent_registry, pass
            // the route, and be refused by the usecase. Gated on the route key
            // alone, the button renders for someone who cannot use it.
            perms={{
                // The register key itself (#3710). The page needs only the
                // inventory read; the risk, skills, coverage and breaker tabs
                // and the tool-manifest pins read under this key, so a reader
                // holding only the view key (AUDITOR) gets them disabled rather
                // than opened and refused.
                canReadRegistry: ctx.appPermissions.admin.agent_registry,
                // ANDed with `canWrite`, not the route key alone. Every
                // mutating risk-assessment and register usecase opens with
                // `assertCanWrite(ctx)` (agent-risk-assessment.ts:197,:256,:608),
                // which reads the role-tier `ctx.permissions.canWrite` rather
                // than the permissions blob — the same two-layer split that
                // makes `canCloseBreaker` a conjunction below. An AUDITOR
                // granted `admin.agent_registry` passes the route and is
                // refused by the usecase, so the key alone renders answer
                // controls that 403 on submit.
                canManageRegistry:
                    ctx.appPermissions.admin.agent_registry && ctx.permissions.canWrite,
                canEditPolicyCard: ctx.appPermissions.admin.agent_policy_card,
                canGrantTools: ctx.appPermissions.admin.agent_tool_exposure,
                canKill: ctx.appPermissions.admin.agent_kill_switch,
                canCloseBreaker:
                    ctx.appPermissions.admin.agent_registry && ctx.permissions.canAdmin,
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
            }}
            viewerUserId={ctx.userId}
        />
    );
}
