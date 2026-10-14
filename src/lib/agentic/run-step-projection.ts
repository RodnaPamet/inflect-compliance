/**
 * The step-row projection one agent run's timeline reads (#3472, plan point 08).
 *
 * ## Why this is a separate module from the usecase that queries
 *
 * Three surfaces project steps — the server-rendered run page, the bounded
 * feed route, and the SSE tail — and the projection used to live inline in the
 * page as ninety lines of reasoning about which column wins and which rung a
 * tool reached. A second copy in a route would rot against it silently, and
 * the copy nobody opened would be the one under-reporting what an agent
 * touched. So it is ONE function.
 *
 * It sits HERE rather than beside `getRunStepFeed` because that usecase
 * reaches Prisma, and Prisma pulls in `app-layer/jobs/queue` -> `bullmq` ->
 * an ESM-only `msgpackr`. A jsdom test that renders the run PAGE therefore
 * failed to load at all once the page imported the usecase — measured, not
 * predicted. The projection needs no database, so the page imports the pure
 * module and the DB-touching half stays out of the client-side graph.
 *
 * ## What it does NOT do
 *
 * It does not widen what reaches a browser. The fields are NAMED, never
 * spread, so adding a column to `WorkflowStep` cannot publish it by accident
 * — the same discipline `getWorkflowRun` applies to its `proposals` include,
 * and for the same reason: an `AgentProposal` carries `payloadJson`, the
 * column the proposals surface refuses to send.
 *
 * `inputJson`/`outputJson` ARE included, because they are what the timeline's
 * disclosure panel shows and the page has always sent them. They arrive
 * DECRYPTED through the Prisma client extension. That is a pre-existing
 * decision owned by the page, not something this module widens; it is called
 * out so a reader does not have to diff the old page to learn it.
 */
import { stepDataScope, stepDeclaration } from './run-step-view';
import type { WorkflowStepDef } from './workflow-types';

/** One step, exactly as the timeline and the canvas read it. */
export interface RunStepFeedRow {
    id: string;
    seq: number;
    kind: string;
    status: string;
    /** The tool that ran, or — on a failed step, which records none — the one the definition declared. */
    tool: string | null;
    /**
     * The data rung that tool reaches, derived on the server from the tool
     * catalogue. Null when the step names no tool: a synthesis or a checkpoint
     * reaches no tenant data by construction, and a chip there would imply a
     * rung was evaluated when none was.
     */
    scope: string | null;
    /**
     * What the guard said about this step. NULL means no guard ran, which is
     * a different fact from `CLEAN` — only tool calls are scanned.
     */
    guardVerdict: string | null;
    /** Stable rule ids that fired. Empty on a clean verdict. */
    guardRuleIds: readonly string[];
    /** Tokens THIS step spent; null on the kinds that spend none. */
    costTokens: number | null;
    /** From the definition; `WorkflowStep` has no label column. */
    label: string | null;
    at: string;
    actorUserId: string | null;
    inputJson: string | null;
    outputJson: string | null;
    /**
     * The `(tenantId, inputDigest)` key of this step's EU AI Act Art 12 row,
     * or null when the step produced none.
     */
    decisionDigest: string | null;
    /**
     * The proposals this step queued. Possibly several — one `buildItems` can
     * produce many — which is why `AgentProposal.stepSeq` carries no unique
     * constraint.
     */
    proposals: ReadonlyArray<{
        id: string;
        kind: string;
        status: string;
        guardVerdict: string;
    }>;
}

/** The step columns the projection reads. Structural, so both callers fit. */
export interface ProjectableStep {
    id: string;
    seq: number;
    kind: string;
    status: string;
    toolCalled: string | null;
    inputJson: string | null;
    outputJson: string | null;
    guardVerdict: string | null;
    guardRuleIds: string[];
    costTokens: number | null;
    at: Date;
    actorUserId: string | null;
}

/** The proposal columns the projection groups by step. */
export interface ProjectableProposal {
    id: string;
    kind: string;
    status: string;
    guardVerdict: string;
    stepSeq: number | null;
}

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
export function decisionDigestOf(inputJson: string | null): string | null {
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

/**
 * Project raw steps onto what a timeline reads. PURE — no database, no context.
 *
 * `defSteps` is the workflow definition's step array when there is one. It
 * fills the label, and the tool on a FAILED step that recorded none.
 */
export function projectRunSteps(
    defSteps: readonly WorkflowStepDef[] | undefined,
    steps: readonly ProjectableStep[],
    proposals: readonly ProjectableProposal[],
): RunStepFeedRow[] {
    // Proposals, grouped onto the step that produced them. Grouped rather than
    // looked up per step because one step may queue SEVERAL — which is exactly
    // why `stepSeq` carries no unique constraint.
    const bySeq = new Map<number, ProjectableProposal[]>();
    for (const p of proposals) {
        if (p.stepSeq === null) continue;
        const list = bySeq.get(p.stepSeq);
        if (list) list.push(p);
        else bySeq.set(p.stepSeq, [p]);
    }

    return steps.map((s) => {
        // NOT `defSteps[s.seq]`. That indexing is only meaningful for the
        // static engine, whose loop walks the definition's array; a Flue run's
        // `seq` counts steps RECORDED and indexes nothing. `declaredStepFor`
        // carries the rule and is tested on its own.
        //
        // Resolved ONCE, and as ONE call: the tool chip, the label and the
        // data rung below all read it, and the rule must not be evaluated
        // twice and risk answering differently.
        const { tool, label } = stepDeclaration(defSteps, s.seq, s.kind, s.toolCalled);
        return {
            id: s.id,
            seq: s.seq,
            kind: s.kind,
            status: s.status,
            // The column first — it is what RAN. The definition only fills the
            // hole a failed step leaves.
            tool,
            // THE DATA RUNG THE TOOL REACHED, derived rather than stored, and
            // ARGUMENT-AWARE: `get_framework_status` is READ_METADATA at base
            // and READ_TENANT_DATA when called with `frameworkKey`, so the
            // minimum-only helper told a reviewer a run had read catalogue
            // metadata when it had touched tenant data. On a governance
            // surface, under-reporting what an agent reached is the one error
            // that matters.
            //
            // Still DERIVED: the rung comes from the recorded args plus TODAY's
            // catalogue, so nothing is migrated and nothing can drift from the
            // authority that enforces it.
            scope: stepDataScope(tool, s.inputJson),
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
            label,
            at: s.at.toISOString(),
            actorUserId: s.actorUserId,
            // Passed as the raw JSON STRING rather than parsed: the client
            // renders it as text inside a disclosure and never interprets it,
            // and a parse here would only move the failure of a malformed blob
            // from a collapsed panel to the whole page.
            inputJson: s.inputJson,
            outputJson: s.outputJson,
            // A GUARDED parse, and only for this one field — so a malformed
            // blob costs the LINK and not the page.
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
}

/**
 * A run whose steps can still change. Anything else replays from the ledger.
 *
 * RE-EXPORTED, NOT RE-DECLARED (#3484). This module had its own copy, and the
 * copy was WRONG: it listed `PENDING`, which sounds like a run status and is
 * not one — `WorkflowRunStatus` is
 * `RUNNING | AWAITING_APPROVAL | PAUSED | COMPLETED | ABORTED | FAILED`. As a
 * plain string Set that typechecked and shipped a claim about a state no row
 * can hold; the concurrent-run cap found it the moment the same list had to be
 * a Prisma `in:` filter, where the enum refuses it.
 *
 * The two readers must agree because they answer the same question — can this
 * run still produce steps? The tail keeps a connection open on it and the cap
 * counts rows by it, so a drift would show up as a stream held for a finished
 * run, or a tenant refused for a run nobody was watching progress. One
 * definition, in `run-concurrency.ts`, with a test asserting it is exactly the
 * non-terminal half of the generated enum.
 */
export { LIVE_RUN_STATUSES, isLiveRunStatus } from './run-concurrency';
