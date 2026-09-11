import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import {
    getAgentGovernanceStatus,
    getAgenticAssuranceSignals,
    listAgentKpiCounts,
    listRegisteredAgents,
    parseAgentListFilters,
} from '@/app-layer/usecases/agent-registry';
import { countAgentProposalsAwaitingReview } from '@/app-layer/usecases/agent-proposals';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { listVendors } from '@/app-layer/usecases/vendor';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { AgentsClient, type AgentRow } from './AgentsClient';
import type { OwnerOption, VendorOption } from './NewAgentModal';

export const dynamic = 'force-dynamic';

/**
 * THE AGENT REGISTER — Server Component, and a standard list page.
 *
 * `/agents`, a top-level sidebar destination beside `/policies` and `/vendors`
 * (AGENTIC UI 1/4, #2421). It used to live at `/admin/agents` and the whole
 * agentic feature was reachable through exactly one thing: a pill labelled
 * "MCP" on the admin landing page. An acronym on a settings page is not
 * navigation.
 *
 * ── WHY THE FILTERS AND THE COUNTS ARE BOTH SERVER-SIDE ─────────────────────
 *
 * This page used to SSR every agent and let the browser filter the array. That
 * is survivable while the table is the only consumer. It stops being
 * survivable the moment a KPI card quotes a number, because the card's filter
 * resolves against the whole tenant while the array is capped — so the card
 * reads 3 and the click produces 47 (#1905). Both halves therefore moved
 * together: `parseAgentListFilters` turns the query string the FilterProvider
 * writes into the repository's filter shape, `listRegisteredAgents` applies it
 * in SQL, and `listAgentKpiCounts` counts with the SAME predicate builder and
 * one term swapped per card.
 *
 * The client still owns the filter UI. Changing a filter pushes to the URL,
 * which re-runs this component (`force-dynamic`) and hands back rows and counts
 * that agree with each other by construction.
 *
 * ── THE GATE IS HERE AS WELL AS IN THE USECASE ──────────────────────────────
 *
 * `listRegisteredAgents` now asserts `admin.agent_registry` itself (#2433), and
 * that is the real boundary. This page ALSO refuses, ahead of it, so a caller
 * without the key gets the ForbiddenPage every other gated surface shows rather
 * than an error boundary — and so no data fetch is started for a caller who is
 * not entitled to any of it.
 *
 * The owner picker is fed from ACTIVE memberships only, because the usecase
 * refuses anything else — offering a name the server will reject is a form that
 * lies. The vendor list is fed for the same reason on the third-party branch.
 */
export default async function AgentRegisterPage({
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

    const filters = parseAgentListFilters(await searchParams);

    const [agents, kpiCounts, governance, assurance, proposalsAwaitingReview, members, vendors] =
        await Promise.all([
            listRegisteredAgents(ctx, { filters }),
            listAgentKpiCounts(ctx, filters),
            getAgentGovernanceStatus(ctx),
            // Best-effort, like the proposal badge beside it: a reader who may
            // see the register but not the audit trail still gets the register,
            // and an absent panel is the honest rendering of "this page cannot
            // tell you" — a zeroed one would not be.
            getAgenticAssuranceSignals(ctx).catch(() => null),
            // The ViewsMenu badge. Best-effort: a reader who may read the
            // register but not the proposal queue still gets the register
            // rather than an error, and an absent badge is the honest
            // rendering of "this page cannot tell you".
            countAgentProposalsAwaitingReview(ctx).catch(() => null),
            listAssignableUsers(ctx),
            listVendors(ctx, {}, { take: 200 }),
        ]);

    // `listAssignableUsers`, not `listTenantMembers`: it is ACTIVE-only by
    // construction, which is exactly the population the usecase will accept as
    // an owner. Offering a name the server is going to reject is a form that
    // lies about what it can do.
    const owners: OwnerOption[] = members.map((m) => ({
        id: m.id,
        label: m.name ?? m.email,
    }));

    const vendorOptions: VendorOption[] = vendors.map((v: { id: string; name: string }) => ({
        id: v.id,
        name: v.name,
    }));

    return (
        <AgentsClient
            initialRows={JSON.parse(JSON.stringify(agents)) as AgentRow[]}
            tenantSlug={resolved.tenantSlug}
            owners={owners}
            vendors={vendorOptions}
            kpiCounts={kpiCounts}
            governance={governance}
            assurance={assurance}
            proposalsAwaitingReview={proposalsAwaitingReview}
            canWrite={Boolean(ctx.appPermissions?.admin?.agent_registry)}
            // The proposal queue is gated `admin.view` at its own page, NOT on
            // the register key — see the note there. The menu entry has to ask
            // the same question the destination asks, or it offers a link that
            // renders a ForbiddenPage.
            canReviewProposals={Boolean(ctx.appPermissions?.admin?.view)}
        />
    );
}
