import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { buildAgentGovernancePack } from '@/app-layer/usecases/agent-governance-reports';
import { getAgentGovernanceStatus } from '@/app-layer/usecases/agent-registry';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ReportsClient } from './ReportsClient';

/**
 * THE ASSESSOR PACK — "show me your agent governance" (4/4).
 *
 * ── WHY THIS PAGE EXISTS AT ALL, GIVEN THE MODULE SAYS IT SHOULD NOT ─
 *
 * `agent-governance-reports.ts` carries a section headed WHY THERE IS NO PAGE,
 * arguing the pack is an artefact to hand over rather than a dashboard to
 * browse, and that a page would be "a sixth place the same rows are rendered,
 * with its own filters to keep in step." That reasoning is recorded and
 * deliberate, and this page is a decision to supersede it — so it answers the
 * objection rather than ignoring it:
 *
 *   · IT HAS NO FILTERS. The pack is fixed: five reports, one window. There is
 *     nothing here to keep in step with the register's own filters, because
 *     there is nothing to steer.
 *   · IT RENDERS NOTHING THE SUBSYSTEM PAGES RENDER. Those show rows; this shows
 *     FIGURES WITH THEIR DEFINITIONS, which is the thing none of them shows and
 *     the only thing an assessor asks for.
 *   · IT IS EXPORT-SHAPED. The screen is the artefact, stamped with tenant,
 *     moment and population, so a screenshot carries its own provenance.
 *
 * ── IT READS LIVE, AND STORES NOTHING ───────────────────────────────
 *
 * Contract B: "every figure is derived from rows the earlier prompts already
 * landed... a governance report that needed its own table would be a second copy
 * of the register, and two copies can disagree about what a tenant runs." So
 * this is a server read per visit. No cache, no snapshot row, no "last
 * generated" — if it is slow, the query is the thing to fix.
 *
 * The permission is the register key, matching the route's: the pack names
 * people — who approved what, who owns which agent.
 */
export default async function AgentReportsPage({
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

    // The governance flag comes from the register's own read rather than being
    // re-derived here: the caveat this page puts at the top must be the SAME
    // answer the register's banner gives, or the two disagree about whether the
    // figures below describe anything enforced.
    const [pack, governance] = await Promise.all([
        buildAgentGovernancePack(ctx),
        getAgentGovernanceStatus(ctx),
    ]);

    return (
        <ReportsClient
            tenantSlug={resolved.tenantSlug}
            // Serialised through JSON the way every other server->client agent
            // payload here is: the envelopes carry `Date`s, and a client
            // component boundary does not.
            pack={JSON.parse(JSON.stringify(pack))}
            enforcing={governance.enforcing}
            // The menu entry must ask the same question its DESTINATION asks, or
            // it offers a link that renders a ForbiddenPage.
            canReviewProposals={Boolean(ctx.appPermissions?.admin?.view)}
            canInvestigate={Boolean(ctx.appPermissions?.admin?.agent_registry)}
            // The SAME question the export usecase asks. Filing the pack writes
            // into the evidence library, which is the library's grant to give
            // and not the register's — so holding this page is not holding this
            // button, and the two keys are read separately here rather than one
            // being inferred from the other.
            canExport={Boolean(ctx.appPermissions?.evidence?.edit)}
        />
    );
}
