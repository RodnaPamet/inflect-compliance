import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import { getWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { baseDataScopeForTool } from '@/lib/mcp/tool-data-scope';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { declaredStepFor, resolveStepTool } from '@/lib/agentic/run-step-view';
import { ForbiddenPage } from '@/components/ForbiddenPage';

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
/**
 * The Art 12 digest a MODEL_CALL step recorded, or null.
 *
 * `AiDecisionLog` carries no `runId`: it is the regulator's record of a
 * DECISION, not the engine's bookkeeping, and the two are joined on
 * `(tenantId, inputDigest)`. The Flue driver records that digest on the step
 * it produced, so this reads it back.
 *
 * NULL for every step that has none — the static driver's steps, tool calls,
 * and any run that predates the digest being recorded. A link is offered only
 * where there is something to open; an anchor that lands on an empty table
 * would be worse than no anchor.
 */
function decisionDigestOf(inputJson: string | null): string | null {
    if (!inputJson) return null;
    try {
        const parsed: unknown = JSON.parse(inputJson);
        if (!parsed || typeof parsed !== 'object') return null;
        const d = (parsed as { decisionDigest?: unknown }).decisionDigest;
        // Shape-checked, not merely present. This value goes into a query
        // string, and `sha256:<hex>` is the only thing the decisions page can
        // do anything with.
        return typeof d === 'string' && /^sha256:[0-9a-f]{64}$/.test(d) ? d : null;
    } catch {
        // A malformed blob is a display problem for the payload panel, not a
        // reason to fail the page.
        return null;
    }
}

export default async function AgentRunDetailPage({
    params,
}: {
    params: Promise<{ tenantSlug: string; runId: string }>;
}) {
    const { tenantSlug, runId } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    const t = await getTranslations('agents');

    // The sibling list page's gate, verbatim. `admin.view` — the orchestrator
    // is an admin surface, and a run's steps are strictly less than the list
    // already shows about the same runs.
    if (!ctx.appPermissions.admin.view) {
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

    // Proposals, grouped onto the step that produced them. Grouped rather than
    // looked up per step because one step may queue SEVERAL — which is exactly
    // why `stepSeq` carries no unique constraint.
    const bySeq = new Map<number, typeof run.proposals>();
    for (const p of run.proposals) {
        if (p.stepSeq === null) continue;
        const list = bySeq.get(p.stepSeq);
        if (list) list.push(p);
        else bySeq.set(p.stepSeq, [p]);
    }

    const steps: RunStepRow[] = run.steps.map((s) => {
        // NOT `def?.steps[s.seq]`. That indexing is only meaningful for the
        // static engine, whose loop walks the definition's array; a Flue run's
        // `seq` counts steps RECORDED and indexes nothing. `declaredStepFor`
        // carries the rule and is tested on its own.
        const declared = declaredStepFor(def?.steps, s.seq, s.kind);
        // Resolved ONCE: both the tool chip and the data rung below read it,
        // and `resolveStepTool` carries a rule (column first, definition only
        // for the hole a failed step leaves) that must not be evaluated twice
        // and risk answering differently.
        const tool = resolveStepTool(s.toolCalled, declared);
        return {
            id: s.id,
            seq: s.seq,
            kind: s.kind,
            status: s.status,
            // The column first — it is what RAN. The definition only fills the
            // hole a failed step leaves. The rule is `resolveStepTool`, which
            // carries the reasoning and is tested on its own.
            tool,
            // THE DATA RUNG THE TOOL REACHES, derived rather than stored.
            //
            // `baseDataScopeForTool` is a pure function of the tool NAME —
            // the catalogue rule, or the class default — so there is nothing
            // to migrate and nothing that can drift from the authority that
            // actually enforces it. Deriving it here rather than recording it
            // on the step is what keeps those two the same fact: if the
            // catalogue reclassifies a tool tomorrow, an old run's timeline
            // re-reads the rung that tool reaches TODAY, which is the honest
            // answer to "what does this step touch".
            //
            // Computed on the SERVER. The helper only type-imports from
            // Prisma and otherwise reaches the tool catalogue, so this adds
            // nothing to the client bundle.
            //
            // Null when the step names no tool — a synthesis or a checkpoint
            // reaches no tenant data by construction, and a chip reading
            // "NONE" there would imply a rung was evaluated when none was.
            scope: tool ? baseDataScopeForTool(tool) : null,
            // WHAT THE GUARD SAID, when one ran. Null is not CLEAN: a
            // checkpoint or a synthesis reaches no tenant content and is never
            // scanned, and a chip reading CLEAN there would tell a reviewer
            // the guard looked at a step it never examined.
            guardVerdict: s.guardVerdict,
            guardRuleIds: s.guardRuleIds,
            // What THIS step spent. The run total stays in the header; this is
            // the per-step breakdown, and it is null on the kinds that spend
            // nothing rather than 0, so a read that cost nothing and a model
            // call whose usage went unreported stay different facts.
            costTokens: s.costTokens,
            label: declared?.label ?? null,
            at: s.at.toISOString(),
            actorUserId: s.actorUserId,
            // Decrypted agent-authored content by the time it reaches here.
            // Passed as the raw JSON STRING rather than parsed: the client
            // renders it as text inside a disclosure and never interprets it,
            // and a parse here would only move the failure of a malformed blob
            // from a collapsed panel to the whole page.
            inputJson: s.inputJson,
            outputJson: s.outputJson,
            // THE LINK TO THIS STEP'S ART 12 ROW, derived here rather than in
            // the client.
            //
            // A GUARDED parse, and only for this one field. The raw string
            // still passes through untouched for display, for the reason
            // stated immediately above — so a malformed blob costs the LINK
            // and not the page, which is the whole point of not parsing it
            // wholesale.
            decisionDigest: decisionDigestOf(s.inputJson),
            // WHAT THIS STEP QUEUED. The other half of the backlink: a
            // proposal names its step, and a step names its proposals, so a
            // reviewer can travel either way between the write and the
            // reasoning that produced it.
            proposals: (bySeq.get(s.seq) ?? []).map((p) => ({
                id: p.id,
                kind: p.kind,
                status: p.status,
                guardVerdict: p.guardVerdict,
            })),
        };
    });

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
            }}
            steps={steps}
        />
    );
}
