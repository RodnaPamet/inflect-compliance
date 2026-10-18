import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { AgentRunsClient, type RunRow } from './AgentRunsClient';

/**
 * Agent runs observability (Epic Agentic 1A). Lists the tenant's agentic
 * workflow runs with live status, cost, and pending checkpoints. An operator can
 * start a workflow, watch its step timeline, resume a paused run (after acting on
 * its proposals), or abort a runaway run.
 */
export default async function AgentRunsPage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    // Reached from the agents ViewsMenu. Server-side gate (before the data
    // load) so a refused reader never triggers the fetch. `admin.view`, which
    // the move to /agents/runs (#2437) did not re-key, OR — since #3710 — the
    // read-only inventory view key (`mayReadAgentActivity`), which AI_ADMIN and
    // AUDITOR hold. Reading only: every run action below asks the role-tier
    // write (`canOperate`), which neither of those roles holds.
    if (!mayReadAgentActivity(ctx.appPermissions.admin)) {
        const t = await getTranslations('agents');
        return (
            <ForbiddenPage
                title={t('runs.accessTitle')}
                message={t('runs.accessMessage')}
            />
        );
    }
    const runs = await listWorkflowRuns(ctx, {});

    const rows: RunRow[] = runs.map((r) => ({
        id: r.id,
        workflowKey: r.workflowKey,
        status: r.status,
        stepCount: r.stepCount,
        costTokens: r.costTokens,
        // WHICH ENGINE walked it. Read off the row rather than re-resolved
        // here: `WorkflowRun.driver` records the driver `selectRunDriver`
        // actually chose at the run's start, and the tenant's configuration
        // may have moved since. A list that re-resolved would relabel finished
        // runs every time an operator flipped a switch.
        driver: r.driver,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        // WHEN THE HUMAN'S WINDOW CLOSES, for a run parked at a checkpoint.
        //
        // Shown here rather than on the compliance calendar, and
        // `calendar-projection-completeness` records why: a calendar entry
        // would turn a bound on deliberation into a prompt to clear the
        // queue. The runs list is where the reviewer is already deciding, so
        // the date is a FACT beside the run rather than a reminder chasing
        // them. Null unless parked.
        approvalExpiresAt: r.approvalExpiresAt ? r.approvalExpiresAt.toISOString() : null,
        summary: r.summary,
        pendingProposals: r._count.proposals,
    }));

    const workflows = listWorkflowDefinitions().map((w) => ({ key: w.key, name: w.name, description: w.description }));

    return (
        <AgentRunsClient
            tenantSlug={tenantSlug}
            initialRuns={rows}
            workflows={workflows}
            // The ROLE-TIER write, resolved on the server. Every mutating
            // workflow-run usecase opens with `assertCanWrite(ctx)`, which reads
            // this rather than the permissions blob — so the page's own
            // `admin.view` gate is not the question the buttons must ask.
            canOperate={ctx.permissions.canWrite}
            // The views menu's other gates, which this page's own no longer
            // implies (#3710): a view-key reader reaches here without the
            // register key or `admin.view`.
            canCompose={ctx.appPermissions.admin.view}
            canInvestigate={ctx.appPermissions.admin.agent_registry}
            canReadReports={mayReadAgentInventory(ctx.appPermissions.admin)}
        />
    );
}
