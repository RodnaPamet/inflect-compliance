import { getServerSession } from 'next-auth';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { authOptions } from '@/auth';
import { listWorkflowRuns } from '@/app-layer/usecases/workflow-runs';
import { getWorkflowDefinition, listWorkflowDefinitions } from '@/lib/agentic/workflow-registry';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { checkAdminAccess } from '@/lib/auth/guard';
import { mayReadAgentActivity, mayReadAgentInventory } from '@/lib/permissions';

import { AgentRunsClient, type RunRow } from './AgentRunsClient';

/**
 * Agent runs observability (Epic Agentic 1A). Lists the tenant's agentic
 * workflow runs with live status, cost, and pending checkpoints. An operator can
 * start a workflow, watch its step timeline, resume a paused run (after acting on
 * its proposals), or abort a runaway run.
 */

/**
 * How many runs the page lists, newest first (#4472).
 *
 * One more is READ than is shown, so a cut list is a fact the page holds rather
 * than one it cannot observe: a list that stops at exactly fifty and a tenant
 * with exactly fifty runs look identical without it.
 */
const RUN_LIST_CAP = 50;
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
    const listed = await listWorkflowRuns(ctx, { take: RUN_LIST_CAP + 1 });
    const truncated = listed.length > RUN_LIST_CAP;

    // THE ONE PROJECTION of a run row (#4472). The client used to re-fetch
    // `GET /agent-runs` after Start, Resume or Abort and render that response
    // as-is — a different shape, carrying `_count.proposals` and no
    // `pendingProposals`, so every paused run's hint then said nothing was
    // queued. It now asks the router to re-render this page instead, so every
    // row the list ever shows comes through here.
    const rows: RunRow[] = listed.slice(0, RUN_LIST_CAP).map((r) => ({
        id: r.id,
        workflowKey: r.workflowKey,
        // What a person calls the workflow, as the run's own page names it. A
        // key with no registered definition (an agent profile run, or a
        // definition since removed) is named by its key.
        workflowName: getWorkflowDefinition(r.workflowKey)?.name ?? r.workflowKey,
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

    // `requiredInput` travels with each workflow so the client can build its
    // start form from the definition's own declaration (`startPlanFor`).
    const workflows = listWorkflowDefinitions().map((w) => ({
        key: w.key,
        name: w.name,
        description: w.description,
        requiredInput: [...(w.requiredInput ?? [])],
    }));

    // MAY THIS CALLER LIST DISCOVERED AGENTS — the discovered-agent review's
    // picker reads `GET …/admin/agents/discovered`, and the page must not offer
    // a picker its caller cannot load (#4472). Both of that request's gates,
    // asked through the functions that apply them rather than a copy:
    //
    //   · the EDGE's admin gate, `checkAdminAccess`, fed what the middleware
    //     feeds it — the session's primary role and `memberships[]` claim.
    //     Not `ctx.role`: that is a custom role's BASE role, and the edge reads
    //     the membership's own. The middleware refuses only `'deny'`, so a
    //     `'defer'` (a claim capped at sign-in) is admitted here as there;
    //   · the inventory key the route's `requirePermission` takes.
    //
    // No session at all offers nothing.
    const session = await getServerSession(authOptions);
    const discoveredAgentsPath = `/api/t/${tenantSlug}/admin/agents/discovered`;
    const startAbilities = {
        discoveredAgents:
            session?.user != null
            && checkAdminAccess(discoveredAgentsPath, session.user.role, session.user.memberships, 'GET') !== 'deny'
            && mayReadAgentInventory(ctx.appPermissions.admin),
        // The Ask page's own gate (`controls.view`, which its sidebar entry and
        // both its routes take), for the link that replaces the ad-hoc
        // question's Start button. Reader-level, and not `canOperate`:
        // following a link starts nothing here.
        askPage: Boolean(ctx.appPermissions.controls?.view),
    };

    return (
        <AgentRunsClient
            tenantSlug={tenantSlug}
            runs={rows}
            truncated={truncated}
            workflows={workflows}
            startAbilities={startAbilities}
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
