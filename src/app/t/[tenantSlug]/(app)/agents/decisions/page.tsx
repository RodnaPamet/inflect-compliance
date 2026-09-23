import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listAiDecisions } from '@/app-layer/usecases/ai-decision-log';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { DecisionsClient } from './DecisionsClient';

/**
 * THE AI DECISION LOG — "what did a model decide, and did a person look?"
 *
 * ── WHY THIS PAGE, AND WHY HERE ─────────────────────────────────────────────
 *
 * `AiDecisionLog` has been written since the risk assessor shipped: one row per
 * model call, which is the EU AI Act Art 12 record, with `humanOutcome`
 * stamped when someone decides, which is Art 14. Nothing ever read those rows
 * back except the evidence emitter, which aggregates them into a figure. So
 * the record existed and could not be inspected — an assessor asking "show me
 * the decisions" had to be handed a number.
 *
 * It lives under `/agents` because that is where agent governance lives; the
 * plan is explicit that `/admin` is not the home for it.
 *
 * ── IT IS THE LINK TARGET POINT 4 ASKS FOR ──────────────────────────────────
 *
 * The plan wants a per-step guard verdict to link to its decision-log row.
 * `?digest=` is that target: `AgentProposal.guardInputDigest` and this table's
 * `inputDigest` are the same value computed over the same content, so a
 * proposal — and, once the tool-boundary guard emits one, a step — can reach
 * every decision taken over what it was guarded on, without either side
 * storing the content.
 *
 * THE MODEL-CALL HALF IS NOW WIRED. `executeFlueRun` records the Art 12
 * digest on the `MODEL_CALL` step it produced, and the run timeline links on
 * it — so a reviewer reaching a model call can open the decision it took.
 *
 * THE TOOL-CALL HALF IS STILL NOT, and for the reason this note originally
 * gave: the tool-boundary guards emit no digest, and the Art 12 row is written
 * per MODEL call, so a tool call has a guard verdict and no decision row to
 * reach. Linking every guarded step would land half of them on an empty table.
 * Inventing a key remains worse than the surface waiting for one.
 *
 * ── READS LIVE, STORES NOTHING ──────────────────────────────────────────────
 *
 * Same contract as `/agents/reports`: a governance surface with its own table
 * would be a second copy of the record, and two copies can disagree about what
 * a tenant ran.
 */
export default async function AgentDecisionsPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ digest?: string }>;
}) {
    const resolved = await params;
    const ctx = await getTenantCtx(resolved);

    // The register key, matching every sibling under `/agents`. The rows name
    // people — `userId` is who decided — so this is not a read for everyone.
    if (!ctx.appPermissions?.admin?.agent_registry) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('register.accessTitle')}
                message={t('register.accessMessage')}
            />
        );
    }

    const { digest } = await searchParams;
    const decisions = await listAiDecisions(ctx, { digest });

    return (
        <DecisionsClient
            tenantSlug={resolved.tenantSlug}
            decisions={decisions}
            // Echoed back so the page can say it is showing a NARROWED view.
            // Without it a digest that matches nothing renders as "no
            // decisions yet", which is a different and wrong claim.
            digest={digest ?? null}
            canReviewProposals={Boolean(ctx.appPermissions?.admin?.view)}
            canInvestigate={Boolean(ctx.appPermissions?.admin?.agent_registry)}
        />
    );
}
