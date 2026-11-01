import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { readWorkflowRunProvenance } from '@/app-layer/usecases/workflow-run-provenance';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { projectRunSteps } from '@/lib/agentic/run-step-projection';
import { parseMountedSkillPins } from '@/lib/agentic/flue/skills/mount-gate';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { mayReadAgentActivity } from '@/lib/permissions';

import { AgentRunDetailClient, type RunStepRow } from './AgentRunDetailClient';

/**
 * One agentic run, step by step.
 *
 * ── WHY THIS PAGE DID NOT EXIST, AND WHAT THAT COST ─────────────────────────
 *
 * `getWorkflowRun` has always returned the run WITH its ordered steps, and
 * `GET /api/t/:slug/agent-runs/:id` has always served them — its docstring even
 * calls the result "a single run with its ordered step timeline". Nothing ever
 * read it. The ledger the engine writes on every step was reachable by curl and
 * by nothing else, which is the same shape as a control that is enforced and
 * invisible: real, and unable to inform anyone.
 *
 * ── SERVER-FETCHED, NOT CLIENT-FETCHED ──────────────────────────────────────
 *
 * The sibling LIST page fetches on the client because it mutates — start,
 * resume and abort all need to re-read. This page only reads, so fetching here
 * deletes the loading branch, the error branch and the `useEffect` that would
 * own them, and keeps `contextJson` — which `getWorkflowRun` returns DECRYPTED
 * — off the wire entirely. The DTO below is an explicit projection for that
 * reason: the usecase returns the whole row, and the whole row is not something
 * to hand a browser.
 *
 * ── THE LABEL AND THE TOOL ARE DERIVED, NOT STORED ──────────────────────────
 *
 * `WorkflowStep` carries no label column — the driver puts the label in the
 * audit row's `detailsJson` and says so at its own write site. The definition
 * is the source: the driver executes `def.steps[seq]`, so `seq` indexes back
 * into the same array here.
 *
 * `toolCalled` gets the same treatment for a sharper reason. The driver's
 * failure path records a step with NO `toolCalled`, so a FAILED read or propose
 * has a NULL tool — a chip reading the column alone is blank on exactly the
 * steps an operator opened this page to inspect. The column wins when set,
 * because it is what actually ran; the definition fills the gap.
 */
export default async function AgentRunDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; runId: string }>;
}) {
    const { tenantSlug, runId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('agents');

    // The sibling list page's gate, verbatim: `admin.view` OR the inventory
    // view key (`mayReadAgentActivity`, #3710). A run's steps are strictly less
    // than the list already shows about the same runs.
    if (!mayReadAgentActivity(ctx.appPermissions.admin)) {
        return (
            <ForbiddenPage
                title={t('runs.accessTitle')}
                message={t('runs.accessMessage')}
            />
        );
    }

    // `getWorkflowRun` throws `notFound()` for a run in another tenant as well
    // as for one that does not exist — RLS scopes the read, so the two are
    // indistinguishable here by design. Rendering Next's 404 rather than
    // letting the error boundary catch it keeps a mistyped id from looking like
    // an outage.
    let run: Awaited<ReturnType<typeof getWorkflowRun>>;
    try {
        run = await getWorkflowRun(ctx, runId);
    } catch {
        notFound();
    }

    const def = getWorkflowDefinition(run.workflowKey);

    // ONE projection, shared with the bounded feed route and the live tail
    // (#3472). It used to live here as ninety lines of reasoning about which
    // column wins and which rung a tool reached; a second copy in a route
    // would have rotted against it silently, and the copy nobody opened would
    // be the one under-reporting what an agent touched.
    const steps: RunStepRow[] = projectRunSteps(def?.steps, run.steps, run.proposals);
    // Who started it and, for an automation-started run, which rule (#4894).
    // A failed read leaves both unnamed rather than failing the page.
    const provenance = await readWorkflowRunProvenance(ctx, run).catch(() => ({ startedBy: null, ruleName: null }));

    return (
        <AgentRunDetailClient
            tenantSlug={tenantSlug}
            run={{
                id: run.id,
                workflowKey: run.workflowKey,
                workflowName: def?.name ?? run.workflowKey,
                status: run.status,
                driver: run.driver,
                stepCount: run.stepCount,
                costTokens: run.costTokens,
                startedAt: run.startedAt.toISOString(),
                completedAt: run.completedAt ? run.completedAt.toISOString() : null,
                summary: run.summary,
                errorMessage: run.errorMessage,
                // THE CAUSE (#3537). Projected explicitly like every other
                // field here — the usecase returns the whole row and the whole
                // row is not something to hand a browser.
                parentExecutionId: run.parentExecutionId,
                startedBy: provenance.startedBy,
                ruleName: provenance.ruleName,
                // WHAT IT WAS TAUGHT (#3666): names, versions and hashes, or
                // null for a run that predates the pin.
                mountedSkills: parseMountedSkillPins(run.mountedSkills),
            }}
            steps={steps}
            // Resume and abort open with `assertCanWrite`, as on the runs list.
            canOperate={ctx.permissions.canWrite}
        />
    );
}
